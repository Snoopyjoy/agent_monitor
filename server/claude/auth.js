import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseJson } from '../util.js';

const execFileAsync = promisify(execFile);
const KEYCHAIN_TIMEOUT_MS = 4000;

function expiryMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

function normalize(oauth, source) {
  if (!oauth?.accessToken) return null;
  return {
    token: oauth.accessToken,
    expiresAt: expiryMs(oauth.expiresAt),
    subscriptionType: oauth.subscriptionType || null,
    source,
  };
}

function keychainSecret(service) {
  return execFileAsync('security', ['find-generic-password', '-s', service, '-w'], {
    timeout: KEYCHAIN_TIMEOUT_MS,
    encoding: 'utf8',
  }).then(
    ({ stdout }) => stdout.trim(),
    err => {
      if (err?.killed) throw new Error('钥匙串读取超时（若弹出授权，请点「始终允许」）');
      return '';
    },
  );
}

/**
 * Claude Code keeps the OAuth token in the login keychain on macOS, and in
 * ~/.claude/.credentials.json elsewhere. The token is only read. Refreshing it
 * from here would rotate the refresh token and log Claude Code out.
 */
export async function readClaudeAuth(claudeHome) {
  const fileJson = parseJson(await readFile(join(claudeHome, '.credentials.json'), 'utf8').catch(() => ''));
  const fromFile = normalize(fileJson?.claudeAiOauth ?? fileJson, 'file');
  let fromKeychain = null;
  if (process.platform === 'darwin') {
    const secret = await keychainSecret('Claude Code-credentials');
    const parsed = parseJson(secret);
    fromKeychain = normalize(parsed?.claudeAiOauth ?? parsed, 'keychain');
  }
  const candidates = [fromFile, fromKeychain].filter(entry => entry?.token);
  const fresh = candidates.filter(entry => !entry.expiresAt || entry.expiresAt > Date.now());
  return fresh.sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0]
    ?? candidates[0]
    ?? { token: null, expiresAt: null, subscriptionType: null, source: 'none' };
}
