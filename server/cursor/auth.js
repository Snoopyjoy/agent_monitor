import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeJwt, parseJson, toText } from '../util.js';

const execFileAsync = promisify(execFile);
const SAFE_PREFIX = 'cursor-safe-storage:v1:';
const KEYCHAIN_TIMEOUT_MS = 4000;

function looksJwt(value) {
  const parts = String(value ?? '').split('.');
  return parts.length === 3 && parts[0].startsWith('eyJ');
}

function keychainPassword(service, account) {
  return execFileAsync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
    timeout: KEYCHAIN_TIMEOUT_MS,
    encoding: 'utf8',
  }).then(
    ({ stdout }) => stdout.trim(),
    err => {
      if (err?.killed) throw new Error('钥匙串读取超时（若弹出授权，请点「始终允许」）');
      throw err;
    },
  );
}

/** Chromium/Electron safeStorage v10 on macOS (PBKDF2-SHA1 + AES-128-CBC). */
function decryptSafeStorageV10(blobBase64, password) {
  const raw = Buffer.from(blobBase64, 'base64');
  if (raw.length < 4 || raw.subarray(0, 3).toString('utf8') !== 'v10') return null;
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const iv = Buffer.alloc(16, 0x20);
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  const plain = Buffer.concat([decipher.update(raw.subarray(3)), decipher.final()]);
  return plain.toString('utf8');
}

async function unwrapStoredToken(stored) {
  const value = toText(stored).trim();
  if (!value) return { token: null, source: 'empty' };
  if (looksJwt(value)) return { token: value, source: 'state.vscdb' };
  if (!value.startsWith(SAFE_PREFIX)) return { token: null, source: 'unknown' };

  // Prefer the CLI/agent Keychain JWT — no Safe Storage prompt, already plaintext.
  try {
    const fromAgent = await keychainPassword('cursor-access-token', 'cursor-user');
    if (looksJwt(fromAgent)) return { token: fromAgent, source: 'keychain:cursor-access-token' };
  } catch {
    /* fall through to Safe Storage decrypt */
  }

  const sealed = value.slice(SAFE_PREFIX.length);
  for (const account of ['Cursor', 'Cursor Key']) {
    try {
      const password = await keychainPassword('Cursor Safe Storage', account);
      if (!password) continue;
      const plain = decryptSafeStorageV10(sealed, password);
      if (looksJwt(plain)) return { token: plain, source: `keychain:Cursor Safe Storage/${account}` };
    } catch {
      /* try next account */
    }
  }
  return { token: null, source: 'encrypted-unreadable' };
}

function userIdFrom(token, kv) {
  const sub = token ? decodeJwt(token)?.sub : null;
  if (sub) return String(sub).split('|').pop();
  const profile = parseJson(kv['cursorAuth/cachedScopedProfile']);
  const fromProfile = profile?.authId || kv['cursorAuth/stripeMembershipAuthId'];
  return fromProfile ? String(fromProfile).split('|').pop() : null;
}

/**
 * Resolve a usable Cursor session token.
 * Newer Cursor builds seal state.vscdb tokens as cursor-safe-storage:v1:; those must be
 * unwrapped (or replaced by the cursor-access-token Keychain item) before API calls.
 */
export async function resolveCursorAuth(kv) {
  const { token, source } = await unwrapStoredToken(kv['cursorAuth/accessToken']);
  const team = parseJson(kv['cursorAuth/cachedTeam']);
  return {
    token,
    source,
    userId: userIdFrom(token, kv),
    account: {
      email: kv['cursorAuth/cachedEmail'] || null,
      membership: kv['cursorAuth/stripeMembershipType'] || null,
      team: team?.name ?? null,
      teamId: team?.teamId ?? null,
    },
  };
}

export function cursorAuthError(auth) {
  if (auth?.token && auth?.userId) return null;
  if (auth?.source === 'encrypted-unreadable') {
    return 'Cursor 登录态已加密，无法读取。若弹出钥匙串授权请点「始终允许」，或在终端执行一次 cursor-agent 登录';
  }
  if (auth?.account?.email) return 'Cursor 本地有账号缓存，但读不到可用登录令牌';
  return 'Cursor 未登录';
}
