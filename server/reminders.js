import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MINUTE, parseJson } from './util.js';
import { duration, pct } from './views/format.js';

const ACTIVE = new Set(['running', 'waiting', 'stalled']);
const TOOL = { codex: 'Codex', cursor: 'Cursor' };
const MAX_ITEMS = 200;

function doneText(t) {
  const parts = ['已完成'];
  if (t.lastRun?.durationMs) parts.push(`用时 ${duration(t.lastRun.durationMs)}`);
  if (t.progress) parts.push(`待办 ${t.progress.done}/${t.progress.total}`);
  return parts.join(' · ');
}

/**
 * Turns task state transitions and quota levels into reminders. Ids are derived from the run
 * that triggered them, so restarts and repeated polls never produce the same reminder twice.
 */
export class Reminders {
  constructor(cfg) {
    this.path = join(cfg.dataDir, 'reminders.json');
    this.items = [];
    this.quotaState = {};
    this.prev = new Map();
    this.primed = new Set();
    this.dirty = false;
    this.stalledMinutes = Math.round(cfg.stalledAfterMs / MINUTE);
  }

  async init() {
    const data = parseJson(await readFile(this.path, 'utf8').catch(() => ''));
    if (!data) return;
    this.items = Array.isArray(data.items) ? data.items : [];
    this.quotaState = data.quotaState ?? {};
  }

  unread() {
    return this.items.filter(r => !r.read);
  }

  markAllRead() {
    let changed = 0;
    for (const r of this.items) {
      if (!r.read) {
        r.read = true;
        changed += 1;
      }
    }
    if (changed) this.dirty = true;
    return changed;
  }

  observeTasks(tool, tasks, now = Date.now()) {
    const firstPass = !this.primed.has(tool);
    for (const t of tasks) {
      const key = `${tool}:${t.id}`;
      const prev = this.prev.get(key);
      this.prev.set(key, { status: t.status, runKey: t.runKey });
      const base = { tool, taskId: t.id, title: t.title, project: t.project };
      const runId = t.runKey ?? prev?.runKey ?? t.updatedAt;

      if (firstPass || !prev) {
        if (t.status === 'waiting') {
          this.#add({ ...base, id: `waiting:${key}:${runId}`, kind: 'waiting', at: now, text: t.waitingReason ?? '等待你确认' });
        } else if (firstPass && t.status === 'completed' && now - (t.updatedAt ?? 0) < 10 * MINUTE) {
          this.#add({ ...base, id: `done:${key}:${runId}`, kind: 'done', at: t.updatedAt, text: doneText(t) });
        }
        continue;
      }

      const wasActive = ACTIVE.has(prev.status);
      // A short Codex turn can start and finish between two polls; the turn id still changes.
      const finishedUnseen = tool === 'codex' && t.runKey && t.runKey !== prev.runKey;
      if (t.status === 'completed' && (wasActive || finishedUnseen)) {
        this.#add({ ...base, id: `done:${key}:${runId}`, kind: 'done', at: now, text: doneText(t) });
      } else if ((t.status === 'aborted' || t.status === 'error') && (wasActive || finishedUnseen)) {
        this.#add({ ...base, id: `aborted:${key}:${runId}`, kind: 'aborted', at: now, text: t.status === 'error' ? '执行出错' : '已中断' });
      } else if (t.status === 'waiting' && prev.status !== 'waiting') {
        this.#add({ ...base, id: `waiting:${key}:${runId}:${now}`, kind: 'waiting', at: now, text: t.waitingReason ?? '等待你确认' });
      } else if (t.status === 'stalled' && prev.status === 'running') {
        this.#add({ ...base, id: `stalled:${key}:${runId}`, kind: 'stalled', at: now, text: `超过 ${this.stalledMinutes} 分钟没有新进展` });
      }
    }
    this.primed.add(tool);
  }

  /** metric: { usedPercent, resetAt, label } for the tool's most constrained quota. */
  observeQuota(tool, metric, now = Date.now()) {
    if (metric?.usedPercent == null) return;
    const used = metric.usedPercent;
    const level = used >= 100 ? 100 : used >= 95 ? 95 : used >= 80 ? 80 : 0;
    const prev = this.quotaState[tool];
    const name = `${TOOL[tool]} ${metric.label}`;
    if (prev) {
      if (level > (prev.level ?? 0)) {
        this.#add({
          id: `quota:${tool}:${level}:${metric.resetAt ?? ''}`,
          kind: 'quota',
          tool,
          at: now,
          title: `${name}已用 ${pct(used)}`,
          text: level >= 100 ? '额度已用完' : '额度快用完了',
        });
      } else if (prev.resetAt && metric.resetAt && metric.resetAt > prev.resetAt + 60 * MINUTE && used < (prev.used ?? 0)) {
        this.#add({ id: `reset:${tool}:${metric.resetAt}`, kind: 'reset', tool, at: now, title: `${name}已重置`, text: `当前已用 ${pct(used)}` });
      }
    }
    if (!prev || prev.level !== level || prev.resetAt !== metric.resetAt || Math.abs((prev.used ?? 0) - used) >= 1) {
      this.quotaState[tool] = { level, resetAt: metric.resetAt ?? null, used };
      this.dirty = true;
    }
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    await mkdir(join(this.path, '..'), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify({ items: this.items, quotaState: this.quotaState }, null, 1));
    await rename(tmp, this.path);
  }

  #add(reminder) {
    if (this.items.some(r => r.id === reminder.id)) return;
    this.items.unshift({ ...reminder, read: false });
    if (this.items.length > MAX_ITEMS) this.items.length = MAX_ITEMS;
    this.dirty = true;
  }
}
