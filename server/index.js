import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Auth, fromUsbPeer, parseCookies } from './auth.js';
import { CodexSource } from './codex/index.js';
import { config } from './config.js';
import { CursorSource } from './cursor/index.js';
import { Reminders } from './reminders.js';
import { ScreenRenderer } from './screen.js';
import { buildSnapshot } from './snapshot.js';
import { errorText, lanAddresses } from './util.js';
import { clock } from './views/format.js';
import { documentTitle, indexPage, layout, loginPage, remindersPage, taskPage } from './views/pages.js';
import { screenPage } from './views/screen.js';

const HTML = 'text/html; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';
const TEXT = 'text/plain; charset=utf-8';
const ASSET_TYPES = { 'style.css': 'text/css; charset=utf-8', 'app.js': 'application/javascript; charset=utf-8' };
const TOOL = { codex: 'Codex', cursor: 'Cursor' };

const codex = new CodexSource(config);
const cursor = new CursorSource(config);
const reminders = new Reminders(config);
const screen = new ScreenRenderer(config);
const auth = await Auth.create(config);
await Promise.all([codex.stats.init(), reminders.init()]);
const assets = await loadAssets();
let snapshot = buildSnapshot({ codex, cursor });

async function loadAssets() {
  const files = {};
  const hash = createHash('sha1');
  for (const [name, type] of Object.entries(ASSET_TYPES)) {
    const body = await readFile(join(config.publicDir, name));
    hash.update(body);
    files[name] = { body, gz: gzipSync(body), type };
  }
  return { files, version: hash.digest('hex').slice(0, 8) };
}

function refreshSnapshot() {
  snapshot = buildSnapshot({ codex, cursor });
  reminders.observeQuota('codex', snapshot.codex.metric);
  reminders.observeQuota('cursor', snapshot.cursor.metric);
  reminders.flush().catch(err => console.error(`[reminders] ${errorText(err)}`));
}

function every(name, ms, task) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await task();
    } catch (err) {
      console.error(`[${name}] ${errorText(err)}`);
    } finally {
      busy = false;
    }
  };
  run();
  setInterval(run, ms);
}

const hashOf = html => createHash('sha1').update(html).digest('base64url').slice(0, 10);

function parseHashes(value) {
  const out = {};
  for (const pair of String(value ?? '').split(',')) {
    const i = pair.indexOf(':');
    if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

function refreshSeconds(req) {
  const sec = Number(parseCookies(req.headers.cookie).am_refresh);
  return config.refreshChoices.includes(sec) ? sec : config.defaultRefreshSec;
}

function send(req, res, status, body, type, headers = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const h = {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  };
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    buf = gzipSync(buf);
    h['Content-Encoding'] = 'gzip';
    h.Vary = 'Accept-Encoding';
  }
  h['Content-Length'] = buf.length;
  res.writeHead(status, h);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function serveAsset(req, res, name) {
  const file = assets.files[name];
  if (!file) return send(req, res, 404, 'Not Found', TEXT);
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
  const body = gz ? file.gz : file.body;
  res.writeHead(200, {
    'Content-Type': file.type,
    'Content-Length': body.length,
    'Cache-Control': 'public, max-age=604800',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Accept-Encoding',
    ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const screenHtml = () => screenPage(snapshot, reminders.items, reminders.unread().length);

async function sendScreen(req, res, headers) {
  let png;
  try {
    png = await screen.png(screenHtml());
  } catch (err) {
    console.error(`[screen] ${errorText(err)}`);
    return send(req, res, 503, errorText(err), TEXT, headers);
  }
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': png.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : png);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function ack(req, res, cookies) {
  if (!sameOrigin(req)) return send(req, res, 403, 'Forbidden', TEXT);
  const body = await readBody(req, 8192);
  const count = reminders.markAllRead();
  if (count) console.log(`[提醒] ${count} 条标为已读（来自 ${req.socket.remoteAddress}）`);
  await reminders.flush();
  const headers = cookies.length ? { 'Set-Cookie': cookies } : {};
  if (req.headers['x-requested-with'] === 'XMLHttpRequest') return send(req, res, 200, '{"ok":true}', JSON_TYPE, headers);
  const back = new URLSearchParams(body).get('back') ?? '';
  const location = /^\/(?![/\\])/.test(back) ? back : '/';
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

function route(path, unread) {
  if (path === '/') return indexPage(snapshot, { unread });
  if (path === '/reminders') return remindersPage({ unread, all: reminders.items }, Date.now());
  const m = /^\/task\/(codex|cursor)\/([^/]+)$/.exec(path);
  if (!m) return null;
  let id;
  try {
    id = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  return taskPage(m[1], (m[1] === 'codex' ? codex : cursor).detail(id), Date.now());
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  if (path.startsWith('/static/')) return serveAsset(req, res, path.slice('/static/'.length));
  if (path === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }
  if (path === '/health') return send(req, res, 200, 'ok', TEXT);

  const access = path === '/screen.png' && fromUsbPeer(req, config.kindleUsbIp) ? { ok: true } : auth.check(req, url);
  if (!access.ok) return send(req, res, 401, loginPage(url.searchParams.has('key')), HTML);
  const cookies = access.setCookie ? [auth.cookie()] : [];

  if (req.method === 'POST' && path === '/ack') return ack(req, res, cookies);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Method Not Allowed', TEXT, { Allow: 'GET, HEAD' });

  if (url.searchParams.has('refresh')) {
    const sec = Number(url.searchParams.get('refresh'));
    url.searchParams.delete('refresh');
    if (config.refreshChoices.includes(sec)) cookies.push(`am_refresh=${sec}; Path=/; Max-Age=31536000; SameSite=Lax`);
    res.writeHead(302, { Location: path + url.search, 'Cache-Control': 'no-store', ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
    return res.end();
  }

  const headers = cookies.length ? { 'Set-Cookie': cookies } : {};
  const unread = reminders.unread();
  if (path === '/api/snapshot') {
    const body = { ...snapshot, reminders: { unread: unread.length, items: reminders.items.slice(0, 50) } };
    return send(req, res, 200, JSON.stringify(body), JSON_TYPE, headers);
  }
  if (path === '/screen') return send(req, res, 200, screenHtml(), HTML, headers);
  if (path === '/screen.png') return sendScreen(req, res, headers);

  const view = route(path, unread);
  if (!view) return send(req, res, 404, '<!DOCTYPE html><meta charset="utf-8"><p>页面不存在。<a href="/">返回首页</a></p>', HTML);
  const sections = view.sections.map(s => ({ ...s, hash: hashOf(s.html) }));

  if (url.searchParams.get('partial') === '1') {
    const known = parseHashes(url.searchParams.get('h'));
    const changed = sections.filter(s => known[s.name] !== s.hash);
    const reload = Object.keys(known).some(name => !sections.some(s => s.name === name));
    return send(req, res, 200, JSON.stringify({
      reload: reload || undefined,
      clock: clock(Date.now()),
      title: documentTitle(view.title, unread.length),
      s: Object.fromEntries(changed.map(s => [s.name, s.html])),
      h: Object.fromEntries(changed.map(s => [s.name, s.hash])),
      u: unread.slice(0, 5).map(r => ({ id: r.id, title: r.title, body: [TOOL[r.tool], r.text].filter(Boolean).join(' · ') })),
    }), JSON_TYPE, headers);
  }

  return send(req, res, 200, layout({
    title: view.title,
    sections,
    refresh: refreshSeconds(req),
    choices: config.refreshChoices,
    now: Date.now(),
    unread,
    assetVersion: assets.version,
  }), HTML, headers);
}

const server = createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error(`[http] ${errorText(err)}`);
    if (!res.headersSent) send(req, res, 500, '服务器内部错误', TEXT);
    else res.end();
  });
});

function listen(port, attempts) {
  return new Promise((resolve, reject) => {
    const onError = err => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE' && attempts > 1) resolve(listen(port + 1, attempts - 1));
      else reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, config.host);
  });
}

every('local', config.localPollMs, async () => {
  await Promise.all([codex.refreshLocal(), cursor.refreshLocal()]);
  reminders.observeTasks('codex', codex.tasks);
  reminders.observeTasks('cursor', cursor.tasks);
  refreshSnapshot();
});
every('remote', config.remotePollMs, async () => {
  await Promise.all([codex.refreshRemote(), cursor.refreshRemote()]);
  refreshSnapshot();
});
every('stats', 60_000, () => codex.stats.refresh());

// An explicit PORT (as set by the LaunchAgent) must not drift, or the Kindle bookmark breaks.
let port;
try {
  port = await listen(config.port, process.env.PORT ? 1 : 10);
} catch (err) {
  console.error(err.code === 'EADDRINUSE' ? `端口 ${config.port} 已被占用，无法启动` : `启动失败：${errorText(err)}`);
  process.exit(1);
}
const lan = config.host === '0.0.0.0' ? lanAddresses() : [];
console.log('\nAgent 监控已启动');
console.log(`  本机浏览器：http://127.0.0.1:${port}/`);
for (const { name, address } of lan) console.log(`  Kindle / 手机（${name}）：http://${address}:${port}/?key=${auth.key}`);
if (!lan.length) console.log('  只监听本机；要让 Kindle 访问，去掉 HOST=127.0.0.1 后重新启动');
if (port !== config.port) console.log(`  注意：端口 ${config.port} 已被占用，这次用的是 ${port}，Kindle 书签要跟着改`);
console.log('');

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    server.close();
    await reminders.flush().catch(() => {});
    process.exit(0);
  });
}
process.on('unhandledRejection', err => console.error(`[unhandled] ${errorText(err)}`));
