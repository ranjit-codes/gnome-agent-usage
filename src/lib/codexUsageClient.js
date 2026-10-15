import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import {decoder} from './oauth.js';
import {SignedOutError, UsageError} from './usageClient.js';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

export function defaultCodexHome() {
    return GLib.getenv('CODEX_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
}

function accountIdFromIdToken(idToken) {
    try {
        const payload = String(idToken ?? '').split('.')[1];
        if (!payload)
            return null;
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
            .padEnd(Math.ceil(payload.length / 4) * 4, '=');
        const claims = JSON.parse(decoder.decode(GLib.base64_decode(base64)));
        return claims?.['https://api.openai.com/auth']?.chatgpt_account_id ?? null;
    } catch {
        return null;
    }
}

async function readCodexAuth() {
    try {
        const path = GLib.build_filenamev([defaultCodexHome(), 'auth.json']);
        const file = Gio.File.new_for_path(path);
        const bytes = await new Promise((resolve, reject) => {
            file.load_contents_async(null, (f, res) => {
                try {
                    const [ok, data] = f.load_contents_finish(res);
                    resolve(ok ? data : null);
                } catch (e) {
                    reject(e);
                }
            });
        });
        if (!bytes)
            return null;
        const auth = JSON.parse(decoder.decode(bytes));
        const tokens = auth?.tokens;
        const accountId = tokens?.account_id || accountIdFromIdToken(tokens?.id_token);
        if (!tokens?.access_token || !accountId ||
            (auth.auth_mode && auth.auth_mode !== 'chatgpt'))
            return null;
        return {accessToken: tokens.access_token, accountId};
    } catch {
        return null;
    }
}

// Reads the local Codex CLI credentials and calls the same subscription usage
// endpoint as Codex CLI. The auth file is read on every poll so a refreshed
// token written by Codex is picked up without restarting the extension.
export class CodexUsageClient {
    constructor() {
        this._session = new Soup.Session();
        this._session.timeout = 15;
    }

    async fetchUsage(cancellable = null) {
        const auth = await readCodexAuth();
        if (!auth)
            throw new SignedOutError('No ChatGPT sign-in found in auth.json. Run codex login.');

        return new Promise((resolve, reject) => {
            const message = Soup.Message.new('GET', USAGE_URL);
            const headers = message.get_request_headers();
            headers.append('Authorization', `Bearer ${auth.accessToken}`);
            headers.append('ChatGPT-Account-Id', auth.accountId);
            headers.append('Accept', 'application/json');
            headers.append('User-Agent', 'codex-cli');

            this._session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        const status = message.status_code;
                        const body = bytes ? decoder.decode(bytes.get_data()) : '';
                        if (status < 200 || status >= 300) {
                            reject(new UsageError(`HTTP ${status} from Codex usage endpoint`, {
                                status,
                                body,
                            }));
                            return;
                        }
                        resolve(body ? JSON.parse(body) : {});
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }
}
