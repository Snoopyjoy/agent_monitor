import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dayKey, errorText, lastDays, parseJson } from '../util.js';

/** Daily token totals Claude Code already aggregates in ~/.claude/stats-cache.json. */
export class ClaudeStats {
  constructor(cfg) {
    this.path = join(cfg.claudeHome, 'stats-cache.json');
    this.data = null;
    this.error = null;
  }

  async refresh() {
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      this.data = null;
      this.error = err?.code === 'ENOENT' ? null : errorText(err);
      return;
    }
    const data = parseJson(text);
    if (!data) {
      this.data = null;
      this.error = 'Claude 用量缓存无法解析';
      return;
    }
    this.data = data;
    this.error = null;
  }

  summary(now = Date.now()) {
    const days = lastDays(7, now);
    const byDay = Object.fromEntries(days.map(d => [d, 0]));
    const byModel = {};
    for (const row of this.data?.dailyModelTokens ?? []) {
      if (!(row.date in byDay)) continue;
      let total = 0;
      for (const [model, n] of Object.entries(row.tokensByModel ?? {})) {
        const value = Number(n) || 0;
        total += value;
        byModel[model] = (byModel[model] ?? 0) + value;
      }
      byDay[row.date] = total;
    }
    const week = days.reduce((sum, date) => sum + byDay[date], 0);
    const asOf = this.data?.lastComputedDate ?? null;
    return {
      ready: Boolean(this.data),
      progress: this.data ? 1 : 0,
      today: { total: byDay[dayKey(now)] ?? 0 },
      week: { total: week },
      daily: days.map(date => ({ date, total: byDay[date] })),
      models: Object.entries(byModel).sort((a, b) => b[1] - a[1]).map(([model, total]) => ({ model, total })),
      asOf,
      stale: Boolean(asOf && asOf !== dayKey(now)),
      error: this.error,
    };
  }
}
