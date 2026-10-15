import { networkInterfaces } from 'node:os';
import { basename } from 'node:path';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const pad = n => String(n).padStart(2, '0');

export function clip(text, max = 200) {
  if (text == null) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function clipBlock(text, max = 2000) {
  if (text == null) return '';
  const s = String(text).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function projectName(path) {
  if (!path) return '';
  const trimmed = String(path).replace(/[\\/]+$/, '');
  return basename(trimmed) || trimmed;
}

export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function lastDays(count, now = Date.now()) {
  return Array.from({ length: count }, (_, i) => dayKey(now - (count - 1 - i) * DAY));
}

export function parseJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function toText(value) {
  if (value == null) return '';
  return typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
}

export function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Codex titles often begin with injected context blocks such as <in-app-browser-context ...>. */
export function stripMarkup(text) {
  return String(text ?? '')
    .slice(0, 2000)
    .replace(/<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, address: a.address });
    }
  }
  return out.sort((a, b) => (a.name === 'en0' ? -1 : b.name === 'en0' ? 1 : 0));
}

export function errorText(err) {
  if (!err) return '未知错误';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return '请求超时';
  const code = err.cause?.code;
  if (code) return `网络不可用（${code}）`;
  return String(err.message || err).replace(/Bearer\s+\S+/gi, 'Bearer ***').slice(0, 160);
}

export async function fetchJson(url, { timeoutMs = 15000, ...init } = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body = parseJson(await res.text());
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (body == null) throw new Error('接口返回的不是 JSON');
  return body;
}
