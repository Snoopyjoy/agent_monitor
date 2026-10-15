import { randomInt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const COOKIE = 'am_key';

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const value = part.slice(i + 1).trim();
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(value);
    } catch {
      out[part.slice(0, i).trim()] = value;
    }
  }
  return out;
}

function hostOnly(host = '') {
  const h = host.toLowerCase();
  return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
}

const ipv4 = address => String(address ?? '').replace(/^::ffff:/, '');
const subnet24 = address => address.slice(0, address.lastIndexOf('.'));

/**
 * The Kindle at the far end of a USBNetLite cable has a fixed address. While the Mac holds an
 * address in that /24, replies to it can only leave through the cable, so no other host can
 * complete a TCP handshake while pretending to be the Kindle.
 */
export function fromUsbPeer(req, peer) {
  if (!peer || ipv4(req.socket.remoteAddress) !== peer) return false;
  return subnet24(ipv4(req.socket.localAddress)) === subnet24(peer);
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

async function loadOrCreateKey(dataDir) {
  const file = join(dataDir, 'access-key');
  const existing = (await readFile(file, 'utf8').catch(() => '')).trim();
  if (existing) return existing;
  const key = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, `${key}\n`, { mode: 0o600 });
  return key;
}

export class Auth {
  static async create(cfg) {
    const auth = new Auth();
    auth.key = cfg.key || (await loadOrCreateKey(cfg.dataDir));
    return auth;
  }

  /**
   * Requests from this Mac itself are trusted only when the Host header is also a loopback
   * name, so a page served from another origin cannot reach the API through DNS rebinding.
   * Every other client (the Kindle on Wi-Fi) must present the key via ?key= or the cookie.
   */
  check(req, url) {
    if (LOOPBACK_ADDRS.has(req.socket.remoteAddress) && LOOPBACK_NAMES.has(hostOnly(req.headers.host))) return { ok: true };
    const fromQuery = url.searchParams.get('key');
    if (fromQuery && sameSecret(fromQuery, this.key)) return { ok: true, setCookie: true };
    const fromCookie = parseCookies(req.headers.cookie)[COOKIE];
    if (fromCookie && sameSecret(fromCookie, this.key)) return { ok: true };
    return { ok: false };
  }

  cookie() {
    return `${COOKIE}=${encodeURIComponent(this.key)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;
  }
}
