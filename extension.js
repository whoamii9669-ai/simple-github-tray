import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {GitHubApiError, GitHubClient} from './githubApi.js';

const REFRESH_INTERVAL_SECONDS = 5 * 60;

function isGithubPage(uri, expectedPathParts) {
    try {
        const parsed = GLib.Uri.parse(uri, GLib.UriFlags.NONE);
        const pathParts = parsed.get_path().split('/').filter(Boolean);
        return parsed.get_scheme() === 'https' && parsed.get_host() === 'github.com' &&
            parsed.get_userinfo() === null &&
            (parsed.get_port() === -1 || parsed.get_port() === 443) &&
            pathParts.length === expectedPathParts;
    } catch (_error) {
        return false;
    }
}

function launchGithubPage(uri, expectedPathParts) {
    if (!isGithubPage(uri, expectedPathParts))
        return;

    try {
        Gio.AppInfo.launch_default_for_uri(uri, null);
    } catch (_error) {
        // There is no useful action to take if the desktop has no browser handler.
    }
}

export default class SimpleGitHubTrayExtension extends Extension {
    enable() {
        this._enabled = true;
        this._settings = this.getSettings();
        this._cache = null;
        this._lastError = null;
        this._loading = false;
        this._generation = 0;
        this._inFlight = null;
        this._requestCancellable = null;
        this._menuOpen = false;

        this._stylesheetFile = this.dir.get_child('stylesheet.css');
        this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        this._theme.load_stylesheet(this._stylesheetFile);

        const panelIconFile = this.dir.get_child('github-mark-light.svg');
        this._panelButton = new PanelMenu.Button(0.0, 'Simple GitHub Tray', false);
        this._panelIcon = new St.Icon({
            gicon: new Gio.FileIcon({file: panelIconFile}),
            style_class: 'system-status-icon github-panel-mark',
            icon_size: 16,
        });
        this._panelButton.add_child(this._panelIcon);
        Main.panel.addToStatusArea('simple-github-tray', this._panelButton, 0, 'right');
        this._panelIconAsset = 'github-mark-light.svg';
        this._panelIconStyleSignal = this._panelIcon.connect(
            'style-changed', () => this._updatePanelIcon());
        this._updatePanelIcon();

        this._menuSignal = this._panelButton.menu.connect(
            'open-state-changed', (_menu, isOpen) => {
                this._menuOpen = isOpen;
                if (isOpen)
                    void this._refresh(false);
            });

        this._settingsSignals = [
            this._settings.connect('changed::username', () => this._identityChanged()),
            this._settings.connect('changed::token', () => this._identityChanged()),
            this._settings.connect('changed::repo-limit', () => this._renderMenu()),
        ];

        this._refreshTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            REFRESH_INTERVAL_SECONDS,
            () => {
                if (this._enabled && this._cache && !this._inFlight)
                    void this._refresh(true);
                return GLib.SOURCE_CONTINUE;
            });

        this._renderMenu();
    }

    disable() {
        this._enabled = false;
        this._generation++;

        if (this._requestCancellable)
            this._requestCancellable.cancel();
        this._requestCancellable = null;
        this._inFlight = null;

        if (this._refreshTimer) {
            GLib.source_remove(this._refreshTimer);
            this._refreshTimer = 0;
        }

        if (this._settings && this._settingsSignals) {
            for (const signalId of this._settingsSignals)
                this._settings.disconnect(signalId);
        }
        this._settingsSignals = null;

        if (this._panelIcon && this._panelIconStyleSignal)
            this._panelIcon.disconnect(this._panelIconStyleSignal);
        this._panelIconStyleSignal = 0;

        if (this._panelButton) {
            if (this._menuSignal)
                this._panelButton.menu.disconnect(this._menuSignal);
            this._panelButton.destroy();
        }

        this._panelButton = null;
        this._panelIcon = null;
        this._panelIconAsset = null;
        this._settings = null;
        this._cache = null;
        this._lastError = null;
        this._loading = false;
        this._menuOpen = false;
        if (this._theme && this._stylesheetFile)
            this._theme.unload_stylesheet(this._stylesheetFile);
        this._theme = null;
        this._stylesheetFile = null;
    }

    _updatePanelIcon() {
        if (!this._panelIcon)
            return;

        try {
            const color = this._panelIcon.get_theme_node().get_foreground_color();
            const luminance = 299 * color.red + 587 * color.green + 114 * color.blue;
            const asset = luminance >= 127500
                ? 'github-mark-light.svg'
                : 'github-mark-dark.svg';
            if (asset === this._panelIconAsset)
                return;

            this._panelIcon.set_gicon(new Gio.FileIcon({
                file: this.dir.get_child(asset),
            }));
            this._panelIconAsset = asset;
        } catch (_error) {
            // Keep the white mark if the panel theme has not resolved yet.
        }
    }

    _identityChanged() {
        this._generation++;
        if (this._requestCancellable)
            this._requestCancellable.cancel();
        this._requestCancellable = null;
        this._inFlight = null;
        this._cache = null;
        this._lastError = null;
        this._loading = false;
        this._renderMenu();

        if (this._menuOpen)
            void this._refresh(false);
    }

    async _refresh(force) {
        if (!this._enabled || this._inFlight)
            return this._inFlight;

        const expectedLogin = this._settings.get_string('username').trim();
        if (!expectedLogin) {
            this._cache = null;
            this._lastError = null;
            this._loading = false;
            this._renderMenu();
            return;
        }

        if (!force && this._cache &&
            this._cache.expectedLogin.toLowerCase() === expectedLogin.toLowerCase() &&
            Date.now() - this._cache.loadedAt < REFRESH_INTERVAL_SECONDS * 1000) {
            this._renderMenu();
            return;
        }

        const generation = this._generation;
        const cancellable = new Gio.Cancellable();
        this._requestCancellable = cancellable;
        this._loading = true;
        this._lastError = null;
        this._renderMenu();

        this._inFlight = (async () => {
            let client = null;
            try {
                const token = this._settings.get_string('token').trim();
                if (!token)
                    throw new GitHubApiError('missing-token');

                client = new GitHubClient(token, cancellable);
                const profile = await client.getAuthenticatedUser();
                if (profile.login.toLowerCase() !== expectedLogin.toLowerCase()) {
                    const error = new GitHubApiError('account-mismatch');
                    error.expectedLogin = expectedLogin;
                    error.actualLogin = profile.login;
                    throw error;
                }

                const [repositoryResult, avatarBytes] = await Promise.all([
                    client.getOwnedRepositories(profile.login),
                    client.downloadAvatar(profile.avatar_url),
                ]);
                const avatarFile = await client.cacheAvatar(avatarBytes, profile.id, cancellable);

                if (generation !== this._generation || !this._enabled)
                    return;

                this._cache = {
                    expectedLogin,
                    profile,
                    repositories: repositoryResult.repositories,
                    publicOnly: repositoryResult.publicOnly,
                    avatarFile,
                    loadedAt: Date.now(),
                };
                this._lastError = null;
            } catch (error) {
                if (generation !== this._generation || !this._enabled)
                    return;

                const kind = error?.kind ?? 'network-error';
                this._lastError = {
                    kind,
                    expectedLogin: error?.expectedLogin,
                    actualLogin: error?.actualLogin,
                };
            } finally {
                if (client)
                    client.close();
                if (generation === this._generation && this._enabled) {
                    this._loading = false;
                    this._requestCancellable = null;
                    this._inFlight = null;
                    this._renderMenu();
                }
            }
        })();

        return this._inFlight;
    }

    _errorText(error) {
        switch (error?.kind) {
        case 'missing-token':
            return 'No token is saved. Open Preferences to add one.';
        case 'invalid-token':
            return 'GitHub rejected this token (HTTP 401). Check or replace it in Preferences.';
        case 'account-mismatch':
            return `This token belongs to @${error.actualLogin}, but the configured username is @${error.expectedLogin}.`;
        case 'rate-limit':
            return 'GitHub API rate limit reached. Wait before trying again.';
        case 'permission-denied':
            return 'GitHub denied repository access. Check the token’s Metadata: read permission.';
        case 'not-found':
            return 'GitHub returned 404. Check the configured username and token access.';
        case 'server-error':
            return 'GitHub is temporarily unavailable. Try again shortly.';
        case 'invalid-response':
            return 'GitHub returned an unreadable response. Try again.';
        case 'network-error':
        case 'avatar-error':
            return 'Could not reach GitHub. Check the network and try again.';
        default:
            return 'GitHub request failed. Try again.';
        }
    }

    _addStatusItem(text, activate = null) {
        const item = new PopupMenu.PopupMenuItem(text, {
            reactive: Boolean(activate),
            can_focus: Boolean(activate),
        });
        if (activate)
            item.connect('activate', activate);
        this._panelButton.menu.addMenuItem(item);
        return item;
    }

    _createHeader() {
        const item = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        item.add_style_class_name('github-header-item');
        const box = new St.BoxLayout({x_expand: true, style_class: 'github-header'});
        let avatarIcon = null;

        if (this._cache?.avatarFile) {
            avatarIcon = new St.Icon({
                gicon: new Gio.FileIcon({file: this._cache.avatarFile}),
                icon_size: 40,
                style_class: 'github-avatar',
            });
        } else {
            avatarIcon = new St.Icon({
                icon_name: 'avatar-default-symbolic',
                icon_size: 40,
                style_class: 'github-avatar',
            });
        }

        const login = this._cache?.profile.login ||
            this._settings.get_string('username').trim() || 'GitHub';
        const label = new St.Label({
            text: login,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'github-header-name',
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        label.clutter_text.max_width_chars = 24;

        const refreshButton = new St.Button({
            style_class: 'button flat github-refresh-button',
            can_focus: true,
            accessible_name: 'Refresh GitHub data',
            child: new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: 16}),
        });
        refreshButton.connect('clicked', () => void this._refresh(true));

        box.add_child(avatarIcon);
        box.add_child(label);
        box.add_child(refreshButton);
        item.add_child(box);
        return item;
    }

    _renderMenu() {
        if (!this._panelButton)
            return;

        const menu = this._panelButton.menu;
        menu.removeAll();
        menu.addMenuItem(this._createHeader());
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const expectedLogin = this._settings.get_string('username').trim();
        if (!expectedLogin) {
            this._addStatusItem('Add your GitHub username and token in Preferences.');
            this._addPreferencesItem();
            return;
        }

        if (this._loading)
            this._addStatusItem(this._cache ? 'Refreshing GitHub data…' : 'Loading GitHub data…');

        if (this._lastError) {
            const errorItem = this._addStatusItem(this._errorText(this._lastError));
            errorItem.label.clutter_text.line_wrap = true;
            this._addStatusItem('Retry', () => void this._refresh(true));
        }

        if (this._cache) {
            if (this._cache.publicOnly)
                this._addStatusItem('Showing public repositories only; private access needs Metadata: read.');

            const submenu = new PopupMenu.PopupSubMenuMenuItem('Repositories', false, {});
            submenu.add_style_class_name('github-menu-item');
            const limit = this._settings.get_int('repo-limit');
            const repositories = limit === 0
                ? this._cache.repositories
                : this._cache.repositories.slice(0, limit);

            if (repositories.length === 0) {
                submenu.menu.addMenuItem(new PopupMenu.PopupMenuItem('No owned repositories found.', {
                    reactive: false,
                    can_focus: false,
                }));
            } else {
                for (const repository of repositories)
                    submenu.menu.addMenuItem(this._createRepositoryItem(repository));
            }
            menu.addMenuItem(submenu);

            const profileItem = new PopupMenu.PopupMenuItem('Open GitHub Profile');
            profileItem.add_style_class_name('github-menu-item');
            profileItem.connect('activate', () => launchGithubPage(this._cache.profile.html_url, 1));
            menu.addMenuItem(profileItem);
        } else if (!this._lastError && !this._loading) {
            this._addStatusItem('Open Preferences to connect to GitHub.');
        }

        if (!this._cache || this._lastError)
            this._addPreferencesItem();
    }

    _createRepositoryItem(repository) {
        const item = new PopupMenu.PopupMenuItem('');
        item.add_style_class_name('github-repository-item');
        const row = new St.BoxLayout({x_expand: true, style_class: 'github-repository-row'});
        const name = new St.Label({
            text: repository.name,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'github-repository-name',
        });
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        name.clutter_text.max_width_chars = 38;

        const stars = new St.Label({
            text: `★ ${Number(repository.stargazers_count).toLocaleString()}`,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'github-star-count',
        });
        row.add_child(name);
        row.add_child(stars);
        item.add_child(row);
        item.connect('activate', () => launchGithubPage(repository.html_url, 2));
        return item;
    }

    _addPreferencesItem() {
        const item = new PopupMenu.PopupMenuItem('Open Preferences');
        item.connect('activate', () => this.openPreferences());
        this._panelButton.menu.addMenuItem(item);
    }
}
