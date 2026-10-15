import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];
const TIMEOUT_MS = 30_000;

/** Renders the e-ink dashboard page to a PNG with headless Chrome, once per distinct page. */
export class ScreenRenderer {
  constructor(cfg) {
    this.browser = cfg.chromePath || BROWSERS.find(p => existsSync(p)) || '';
    this.dir = join(cfg.dataDir, 'screen');
    this.profile = join(this.dir, 'profile');
    this.size = cfg.screenSize;
    this.last = null;
    this.queue = Promise.resolve();
    // A server that died mid-capture leaves headless Chrome running and holding the profile lock.
    execFile('pkill', ['-f', `--user-data-dir=${this.profile}`], () => {});
  }

  png(html) {
    const job = this.queue.then(() => (this.last?.html === html ? this.last.png : this.#render(html)));
    this.queue = job.catch(() => {});
    return job;
  }

  async #render(html) {
    if (!this.browser) throw new Error('没找到 Chrome，无法生成看板图片（可用 CHROME_PATH 指定浏览器路径）');
    await mkdir(this.dir, { recursive: true });
    const page = join(this.dir, 'screen.html');
    const out = join(this.dir, 'screen.png');
    await writeFile(page, html);
    await rm(out, { force: true });
    await this.#capture(pathToFileURL(page).href, out);
    const png = await readFile(out);
    this.last = { html, png };
    return png;
  }

  #capture(url, out) {
    const { width, height, scale } = this.size;
    const args = [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
      '--disable-background-networking', '--disable-component-update', '--password-store=basic', '--use-mock-keychain',
      `--user-data-dir=${this.profile}`, `--force-device-scale-factor=${scale}`,
      `--window-size=${Math.round(width / scale)},${Math.round(height / scale)}`, `--screenshot=${out}`, url,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.browser, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let settled = false;
      const settle = err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => settle(new Error('Chrome 截图超时')), TIMEOUT_MS);
      const onOutput = chunk => {
        output = (output + chunk).slice(-2000);
        // Headless Chrome on macOS keeps running after --screenshot, so stop it once the file is out.
        if (output.includes('bytes written to file')) settle();
      };
      child.stdout.on('data', onOutput);
      child.stderr.on('data', onOutput);
      child.on('error', settle);
      child.on('exit', code => settle(existsSync(out) ? null : new Error(`Chrome 异常退出（${code}）`)));
    });
  }
}
