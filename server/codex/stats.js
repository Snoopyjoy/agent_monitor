import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { scanLines } from '../lines.js';
import { DAY, dayKey, lastDays, parseJson } from '../util.js';

const CACHE_VERSION = 2;
const WANTED = /"type":"(?:turn_context"|event_msg","payload":\{"type":"token_count")/;
const SESSION_META = /^\{"timestamp":"([^"]+)"[^\n]{0,80}"type":"session_meta"/;
const THREAD_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

const emptyBucket = () => ({ input: 0, cached: 0, output: 0, total: 0, responses: 0 });

/**
 * Daily token usage from rollout `token_count` events. Each file is scanned once and then only
 * its appended bytes; per-file aggregates are cached in data/ so restarts are incremental.
 */
export class CodexStats {
  constructor(cfg) {
    this.cfg = cfg;
    this.cachePath = join(cfg.dataDir, 'codex-usage-cache.json');
    this.files = {};
    this.lastTotals = {};
    this.latestRateLimits = null;
    this.ready = false;
    this.progress = 0;
    this.busy = false;
    this.dirty = false;
    this.modelHint = () => null;
  }

  async init() {
    const cached = parseJson(await readFile(this.cachePath, 'utf8').catch(() => ''));
    if (cached?.version !== CACHE_VERSION) return;
    this.files = cached.files ?? {};
    this.lastTotals = cached.lastTotals ?? {};
    this.latestRateLimits = cached.latestRateLimits ?? null;
  }

  async refresh() {
    if (this.busy) return;
    this.busy = true;
    try {
      const cutoff = Date.now() - this.cfg.statsDays * DAY;
      const files = (await this.#list()).filter(f => f.mtimeMs >= cutoff).sort((a, b) => a.name.localeCompare(b.name));
      const present = new Set(files.map(f => f.path));
      for (const path of Object.keys(this.files)) {
        if (!present.has(path)) {
          delete this.files[path];
          this.dirty = true;
        }
      }
      const pending = files.reduce((sum, f) => sum + Math.max(0, f.size - (this.files[f.path]?.offset ?? 0)), 0);
      let done = 0;
      for (const f of files) {
        let entry = this.files[f.path];
        if (!entry || f.size < entry.offset) {
          entry = this.files[f.path] = { offset: 0, threadId: f.threadId, model: null, startAt: 0, days: {} };
        }
        if (f.size === entry.offset) continue;
        const before = entry.offset;
        entry.offset = await scanLines(f.path, entry.offset, head => this.#wanted(entry, head), line => this.#apply(entry, line));
        done += f.size - before;
        this.progress = pending ? Math.min(1, done / pending) : 1;
        this.dirty = true;
      }
      this.ready = true;
      this.progress = 1;
      if (this.dirty) await this.#save();
    } finally {
      this.busy = false;
    }
  }

  summary(now = Date.now()) {
    const days = lastDays(7, now);
    const byDay = Object.fromEntries(days.map(d => [d, emptyBucket()]));
    const byModel = {};
    for (const entry of Object.values(this.files)) {
      for (const [day, models] of Object.entries(entry.days)) {
        const bucket = byDay[day];
        if (!bucket) continue;
        for (const [model, r] of Object.entries(models)) {
          bucket.input += r[0];
          bucket.cached += r[1];
          bucket.output += r[2];
          bucket.total += r[3];
          bucket.responses += r[4];
          byModel[model] = (byModel[model] ?? 0) + r[3];
        }
      }
    }
    const week = emptyBucket();
    for (const b of Object.values(byDay)) for (const k of Object.keys(week)) week[k] += b[k];
    return {
      ready: this.ready,
      progress: this.progress,
      today: byDay[dayKey(now)],
      week,
      daily: days.map(date => ({ date, ...byDay[date] })),
      models: Object.entries(byModel).sort((a, b) => b[1] - a[1]).map(([model, total]) => ({ model, total })),
    };
  }

  /** Runs on every line head; also notes when the file's session started (cheaply, from the head). */
  #wanted(entry, head) {
    if (!entry.startAt) {
      const meta = SESSION_META.exec(head);
      if (meta) entry.startAt = Date.parse(meta[1]) || 0;
    }
    return WANTED.test(head);
  }

  #apply(entry, line) {
    const o = parseJson(line);
    if (!o) return;
    const p = o.payload ?? {};
    if (o.type === 'turn_context') {
      if (p.model) entry.model = p.model;
      return;
    }
    if (p.type !== 'token_count') return;
    const ts = Date.parse(o.timestamp) || 0;
    if (p.rate_limits && (!this.latestRateLimits || ts >= this.latestRateLimits.at)) this.latestRateLimits = { at: ts, data: p.rate_limits };
    const last = p.info?.last_token_usage;
    if (!last) return;
    // Forked threads may carry copied history from before this file was created.
    if (entry.startAt && ts < entry.startAt - 1000) return;
    // Codex re-emits identical token_count events (e.g. on rate-limit refresh); the running
    // thread total only changes when a new response was billed.
    const total = p.info.total_token_usage?.total_tokens;
    if (total != null) {
      if (this.lastTotals[entry.threadId] === total) return;
      this.lastTotals[entry.threadId] = total;
    }
    const model = entry.model || this.modelHint(entry.threadId) || 'unknown';
    const day = (entry.days[dayKey(ts)] ??= {});
    const rec = (day[model] ??= [0, 0, 0, 0, 0]);
    rec[0] += last.input_tokens ?? 0;
    rec[1] += last.cached_input_tokens ?? 0;
    rec[2] += last.output_tokens ?? 0;
    rec[3] += last.total_tokens ?? (last.input_tokens ?? 0) + (last.output_tokens ?? 0);
    rec[4] += 1;
  }

  async #list() {
    const out = [];
    for (const sub of ['sessions', 'archived_sessions']) {
      const dir = join(this.cfg.codexHome, sub);
      let names;
      try {
        names = await readdir(dir, { recursive: true });
      } catch {
        continue;
      }
      for (const rel of names) {
        if (!rel.endsWith('.jsonl')) continue;
        const path = join(dir, rel);
        try {
          const s = await stat(path);
          const name = basename(rel);
          out.push({ path, name, size: s.size, mtimeMs: s.mtimeMs, threadId: THREAD_ID.exec(name)?.[1] ?? name });
        } catch {
          // file moved to archived_sessions between readdir and stat
        }
      }
    }
    return out;
  }

  async #save() {
    await mkdir(this.cfg.dataDir, { recursive: true });
    const tmp = `${this.cachePath}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, files: this.files, lastTotals: this.lastTotals, latestRateLimits: this.latestRateLimits }));
    await rename(tmp, this.cachePath);
    this.dirty = false;
  }
}
