import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const PAGE_SIZE = 100;
const MAX_AVATAR_BYTES = 1024 * 1024;

export class GitHubApiError extends Error {
    constructor(kind) {
        super(kind);
        this.name = 'GitHubApiError';
        this.kind = kind;
    }
}

function isSafeApiUrl(uri) {
    try {
        const parsed = GLib.Uri.parse(uri, GLib.UriFlags.NONE);
        return parsed.get_scheme() === 'https' && parsed.get_host() === 'api.github.com' &&
            parsed.get_userinfo() === null &&
            (parsed.get_port() === -1 || parsed.get_port() === 443);
    } catch (_error) {
        return false;
    }
}

function nextPageUrl(linkHeader) {
    if (!linkHeader)
        return null;

    const match = linkHeader.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (!match || !isSafeApiUrl(match[1]))
        return null;

    return match[1];
}

function classifyHttpError(status, headers, responseText) {
    const remaining = headers.get_one('X-RateLimit-Remaining');
    const retryAfter = headers.get_one('Retry-After');

    if (status === 401)
        return new GitHubApiError('invalid-token');
    // GitHub may report a secondary rate limit as a 403 without rate headers.
    if ((status === 403 || status === 429) &&
        (remaining === '0' || retryAfter || status === 429 ||
         responseText.toLowerCase().includes('rate limit'))) {
        return new GitHubApiError('rate-limit');
    }
    if (status === 403)
        return new GitHubApiError('permission-denied');
    if (status === 404)
        return new GitHubApiError('not-found');
    if (status >= 500)
        return new GitHubApiError('server-error');

    return new GitHubApiError('request-failed');
}

function sendAndRead(session, message, cancellable) {
    return new Promise((resolve, reject) => {
        session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (source, result) => {
                try {
                    resolve(source.send_and_read_finish(result));
                } catch (_error) {
                    reject(new GitHubApiError('network-error'));
                }
            });
    });
}

function replaceContents(file, contents, cancellable) {
    return new Promise((resolve, reject) => {
        file.replace_contents_async(
            contents,
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            cancellable,
            (source, result) => {
                try {
                    source.replace_contents_finish(result);
                    resolve();
                } catch (_error) {
                    reject(new GitHubApiError('avatar-error'));
                }
            });
    });
}

function circularAvatarSvg(bytes) {
    const data = bytes.get_data();
    const startsWith = (signature, offset = 0) =>
        signature.every((byte, index) => data[offset + index] === byte);
    let mimeType = null;

    if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        mimeType = 'image/png';
    else if (startsWith([0xff, 0xd8, 0xff]))
        mimeType = 'image/jpeg';
    else if (startsWith([0x47, 0x49, 0x46, 0x38]))
        mimeType = 'image/gif';
    else if (startsWith([0x52, 0x49, 0x46, 0x46]) &&
        startsWith([0x57, 0x45, 0x42, 0x50], 8))
        mimeType = 'image/webp';

    if (!mimeType)
        return null;

    const encodedImage = GLib.base64_encode(data);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
        `<defs><clipPath id="avatar-circle"><circle cx="48" cy="48" r="48"/></clipPath></defs>` +
        `<image x="0" y="0" width="96" height="96" preserveAspectRatio="xMidYMid slice" ` +
        `clip-path="url(#avatar-circle)" href="data:${mimeType};base64,${encodedImage}"/>` +
        `</svg>`;
    return new TextEncoder().encode(svg);
}

export class GitHubClient {
    constructor(token, cancellable = null) {
        this._token = token;
        this._cancellable = cancellable;
        this._session = new Soup.Session({timeout: 20});
    }

    close() {
        this._session.abort();
    }

    async _requestJson(uri, authenticated = true) {
        if (!isSafeApiUrl(uri))
            throw new GitHubApiError('request-failed');

        const message = Soup.Message.new('GET', uri);
        message.set_flags(Soup.MessageFlags.NO_REDIRECT);
        message.request_headers.append('Accept', 'application/vnd.github+json');
        if (authenticated)
            message.request_headers.append('Authorization', `Bearer ${this._token}`);
        message.request_headers.append('X-GitHub-Api-Version', API_VERSION);
        message.request_headers.append('User-Agent', 'Simple-GitHub-Tray');

        const body = await sendAndRead(this._session, message, this._cancellable);
        const text = new TextDecoder('utf-8').decode(body.get_data());

        if (message.status_code < 200 || message.status_code >= 300) {
            throw classifyHttpError(
                message.status_code,
                message.get_response_headers(),
                text);
        }

        try {
            return {
                data: JSON.parse(text),
                link: message.get_response_headers().get_one('Link'),
            };
        } catch (_error) {
            throw new GitHubApiError('invalid-response');
        }
    }

    async getAuthenticatedUser() {
        const {data} = await this._requestJson(`${API_BASE}/user`);
        if (!data || typeof data.login !== 'string' || typeof data.id !== 'number')
            throw new GitHubApiError('invalid-response');
        return data;
    }

    async getOwnedRepositories(login) {
        const repositories = [];
        let publicOnly = false;

        try {
            repositories.push(...await this._getOwnedRepositoryPages(
                `${API_BASE}/user/repos?affiliation=owner&visibility=all&sort=full_name&per_page=${PAGE_SIZE}&page=1`,
                login,
                true));
        } catch (error) {
            if (error?.kind !== 'permission-denied')
                throw error;

            // Public repositories remain available without repository permissions.
            publicOnly = true;
            repositories.push(...await this._getOwnedRepositoryPages(
                `${API_BASE}/users/${encodeURIComponent(login)}/repos?type=owner&sort=full_name&per_page=${PAGE_SIZE}&page=1`,
                login,
                false));
        }

        repositories.sort((a, b) => {
            const starDifference = b.stargazers_count - a.stargazers_count;
            return starDifference || a.name.localeCompare(b.name);
        });

        return {repositories, publicOnly};
    }

    async _getOwnedRepositoryPages(firstUrl, login, authenticated) {
        const repositories = [];
        const seen = new Set();
        let uri = firstUrl;

        while (uri) {
            const {data, link} = await this._requestJson(uri, authenticated);
            if (!Array.isArray(data))
                throw new GitHubApiError('invalid-response');

            for (const repository of data) {
                if (!repository || !repository.owner ||
                    repository.owner.login?.toLowerCase() !== login.toLowerCase() ||
                    typeof repository.name !== 'string' ||
                    typeof repository.html_url !== 'string' ||
                    !Number.isFinite(repository.stargazers_count)) {
                    continue;
                }

                const key = String(repository.id ?? repository.full_name ?? repository.name).toLowerCase();
                if (seen.has(key))
                    continue;

                try {
                    const url = GLib.Uri.parse(repository.html_url, GLib.UriFlags.NONE);
                    const parts = url.get_path().split('/').filter(Boolean);
                    if (url.get_scheme() !== 'https' || url.get_host() !== 'github.com' ||
                        url.get_userinfo() !== null ||
                        (url.get_port() !== -1 && url.get_port() !== 443) || parts.length !== 2 ||
                        parts[0].toLowerCase() !== login.toLowerCase() ||
                        parts[1].toLowerCase() !== repository.name.toLowerCase()) {
                        continue;
                    }
                } catch (_error) {
                    continue;
                }

                seen.add(key);
                repositories.push(repository);
            }

            uri = nextPageUrl(link);
        }

        return repositories;
    }

    async downloadAvatar(avatarUrl) {
        let url;
        try {
            url = GLib.Uri.parse(avatarUrl, GLib.UriFlags.NONE);
        } catch (_error) {
            return null;
        }

        if (url.get_scheme() !== 'https' || url.get_host() !== 'avatars.githubusercontent.com' ||
            url.get_userinfo() !== null ||
            (url.get_port() !== -1 && url.get_port() !== 443)) {
            return null;
        }

        const message = Soup.Message.new('GET', avatarUrl);
        message.set_flags(Soup.MessageFlags.NO_REDIRECT);
        message.request_headers.append('Accept', 'image/webp,image/png,image/jpeg,image/gif');

        try {
            const body = await sendAndRead(this._session, message, this._cancellable);
            if (message.status_code !== 200 || body.get_size() > MAX_AVATAR_BYTES)
                return null;

            const contentType = message.get_response_headers().get_one('Content-Type') ?? '';
            if (!contentType.toLowerCase().startsWith('image/'))
                return null;

            return body;
        } catch (_error) {
            return null;
        }
    }

    async cacheAvatar(bytes, userId, cancellable = this._cancellable) {
        if (!bytes)
            return null;

        const svgBytes = circularAvatarSvg(bytes);
        if (!svgBytes)
            return null;

        const directoryPath = GLib.build_filenamev([
            GLib.get_user_cache_dir(),
            'simple-github-tray',
        ]);
        try {
            GLib.mkdir_with_parents(directoryPath, 0o700);
            const file = Gio.File.new_for_path(`${directoryPath}/avatar-${userId}.svg`);
            await replaceContents(file, svgBytes, cancellable);
            return file;
        } catch (_error) {
            return null;
        }
    }
}
