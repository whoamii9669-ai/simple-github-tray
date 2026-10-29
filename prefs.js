import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {GitHubApiError, GitHubClient} from './githubApi.js';

const REPOSITORY_LIMITS = [5, 10, 20, 50, 0];

function connectionErrorText(error, expectedLogin = '') {
    switch (error?.kind) {
    case 'missing-token':
        return _('No token is saved. Enter a token and choose Save token.');
    case 'invalid-token':
        return _('GitHub rejected the token (HTTP 401). Check that the token is active and copy it again.');
    case 'account-mismatch':
        return _('This token belongs to @%s, but the configured username is @%s. Update one of them; the username will not be changed automatically.').format(
            error.actualLogin, expectedLogin);
    case 'rate-limit':
        return _('GitHub rate limit reached. Wait before checking again.');
    case 'permission-denied':
        return _('GitHub denied access. For private repositories, grant the fine-grained token Metadata: read access to those repositories.');
    case 'not-found':
        return _('GitHub returned 404. Check the token and username.');
    case 'server-error':
        return _('GitHub is temporarily unavailable. Try again shortly.');
    case 'network-error':
        return _('Could not reach GitHub. Check the network and try again.');
    default:
        return _('The connection check failed. Try again.');
    }
}

export default class SimpleGitHubTrayPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: _('GitHub'),
            icon_name: 'dialog-password-symbolic',
        });
        window.add(page);

        const accountGroup = new Adw.PreferencesGroup({
            title: _('Account'),
            description: _('For private repositories, use a fine-grained token with read-only Metadata permission for the selected repositories. Public repositories need no repository permission. The token is stored in ordinary GSettings without encryption.'),
        });
        page.add(accountGroup);

        const usernameRow = new Adw.EntryRow({title: _('GitHub Username')});
        usernameRow.set_input_purpose(Gtk.InputPurpose.USERNAME);
        usernameRow.text = settings.get_string('username');
        accountGroup.add(usernameRow);

        const tokenRow = new Adw.PasswordEntryRow({title: _('Personal Access Token')});
        tokenRow.text = settings.get_string('token');
        accountGroup.add(tokenRow);

        const statusRow = new Adw.ActionRow({
            title: _('Token storage'),
            subtitle: settings.get_string('token')
                ? _('Token is saved in GSettings without encryption.')
                : _('No token is saved.'),
        });
        accountGroup.add(statusRow);

        const saveButton = new Gtk.Button({
            label: _('Save'),
            valign: Gtk.Align.CENTER,
        });
        const saveRow = new Adw.ActionRow({
            title: _('Save credentials'),
            subtitle: _('Save the username and token in ordinary GNOME settings.'),
        });
        saveRow.add_suffix(saveButton);
        accountGroup.add(saveRow);

        const testButton = new Gtk.Button({
            label: _('Check connection'),
            valign: Gtk.Align.CENTER,
        });
        const clearButton = new Gtk.Button({
            label: _('Remove token'),
            valign: Gtk.Align.CENTER,
        });
        const checkRow = new Adw.ActionRow({
            title: _('GitHub connection'),
            subtitle: _('Not checked yet.'),
        });
        checkRow.add_suffix(clearButton);
        checkRow.add_suffix(testButton);
        accountGroup.add(checkRow);

        const displayGroup = new Adw.PreferencesGroup({title: _('Display')});
        page.add(displayGroup);

        const limitModel = new Gtk.StringList({
            strings: ['5', '10', '20', '50', _('All available')],
        });
        const limitRow = new Adw.ComboRow({
            title: _('Repositories to display'),
            subtitle: _('Repositories are sorted by stars.'),
            model: limitModel,
            expression: Gtk.PropertyExpression.new(Gtk.StringObject, null, 'string'),
        });
        displayGroup.add(limitRow);

        const currentLimit = settings.get_int('repo-limit');
        const currentIndex = REPOSITORY_LIMITS.indexOf(currentLimit);
        limitRow.selected = currentIndex >= 0 ? currentIndex : 1;
        limitRow.connect('notify::selected', () => {
            const index = limitRow.selected;
            if (index >= 0 && index < REPOSITORY_LIMITS.length)
                settings.set_int('repo-limit', REPOSITORY_LIMITS[index]);
        });

        let tokenSaved = Boolean(settings.get_string('token'));
        let busy = false;

        const setBusy = value => {
            busy = value;
            saveButton.sensitive = !busy;
            testButton.sensitive = !busy;
            clearButton.sensitive = !busy && tokenSaved;
        };

        const saveEnteredToken = () => {
            const token = tokenRow.text.trim();
            if (!token) {
                if (!tokenSaved)
                    statusRow.subtitle = _('Username saved. Enter a token and choose Save.');
                else
                    statusRow.subtitle = _('The existing token remains saved. Enter a new token to replace it.');
                return null;
            }

            settings.set_string('token', token);
            tokenSaved = true;
            statusRow.subtitle = _('Token saved in GSettings without encryption.');
            clearButton.sensitive = true;
            return token;
        };

        saveButton.connect('clicked', async () => {
            if (busy)
                return;
            setBusy(true);
            try {
                const username = usernameRow.text.trim();
                if (!username) {
                    statusRow.subtitle = _('Enter a GitHub username first.');
                    return;
                }
                settings.set_string('username', username);
                saveEnteredToken();
            } catch (_error) {
                statusRow.subtitle = _('Could not save settings.');
            } finally {
                setBusy(false);
            }
        });

        clearButton.connect('clicked', async () => {
            if (busy || !tokenSaved)
                return;
            setBusy(true);
            try {
                settings.set_string('token', '');
                tokenSaved = false;
                tokenRow.text = '';
                statusRow.subtitle = _('Token removed from GSettings.');
                checkRow.subtitle = _('No token is saved.');
            } catch (_error) {
                statusRow.subtitle = _('Could not remove the token.');
            } finally {
                setBusy(false);
            }
        });

        testButton.connect('clicked', async () => {
            if (busy)
                return;

            setBusy(true);
            checkRow.subtitle = _('Checking GitHub…');
            let client = null;
            try {
                const username = usernameRow.text.trim();
                if (!username) {
                    checkRow.subtitle = _('Enter a GitHub username first.');
                    return;
                }
                settings.set_string('username', username);

                let token = tokenRow.text.trim();
                if (token) {
                    settings.set_string('token', token);
                    tokenSaved = true;
                    statusRow.subtitle = _('Token saved in GSettings without encryption.');
                    clearButton.sensitive = true;
                } else {
                    token = settings.get_string('token').trim();
                }

                if (!token)
                    throw new GitHubApiError('missing-token');

                client = new GitHubClient(token);
                const profile = await client.getAuthenticatedUser();
                if (profile.login.toLowerCase() !== username.toLowerCase()) {
                    const error = new GitHubApiError('account-mismatch');
                    error.actualLogin = profile.login;
                    throw error;
                }

                checkRow.subtitle = _('Connected as @%s. The username matches the token.').format(profile.login);
            } catch (error) {
                const username = settings.get_string('username').trim();
                checkRow.subtitle = connectionErrorText(error, username);
            } finally {
                if (client)
                    client.close();
                setBusy(false);
            }
        });

        clearButton.sensitive = tokenSaved;
    }
}
