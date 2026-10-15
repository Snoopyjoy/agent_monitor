const ACTIVE = new Set(['running', 'waiting', 'stalled']);
const PRIORITY = { waiting: 0, stalled: 1, running: 2 };

export function windowLabel(seconds) {
  if (!seconds) return '';
  const hours = seconds / 3600;
  if (Math.abs(hours - 168) < 1) return '每周';
  if (Math.abs(hours - 24) < 0.5) return '每日';
  if (hours < 24) return `${Math.round(hours)} 小时`;
  return `${Math.round(hours / 24)} 天`;
}

/** Linear projection of usage to the end of the window, once enough of it has elapsed. */
function project(usedPercent, start, end, now) {
  const total = end - start;
  const elapsed = now - start;
  if (!(total > 0) || elapsed < total * 0.05 || now >= end) return null;
  const rate = usedPercent / elapsed;
  const atEnd = usedPercent + rate * (end - now);
  const exhaustAt = rate > 0 && usedPercent < 100 ? now + (100 - usedPercent) / rate : null;
  return { atEnd, exhaustAt: exhaustAt && exhaustAt < end ? exhaustAt : null };
}

function codexMetric(q, now) {
  if (!q?.windows?.length) return null;
  const windows = q.windows.map(w => {
    const expired = Boolean(w.resetAt && w.resetAt <= now);
    const used = expired ? 0 : Math.max(0, Math.min(100, w.usedPercent));
    const start = w.resetAt && w.windowSeconds ? w.resetAt - w.windowSeconds * 1000 : null;
    return {
      ...w,
      used,
      remaining: 100 - used,
      expired,
      label: windowLabel(w.windowSeconds),
      projection: !expired && start ? project(used, start, w.resetAt, now) : null,
    };
  });
  const main = windows.reduce((a, b) => (b.used > a.used ? b : a));
  return {
    windows,
    main,
    usedPercent: q.limitReached ? 100 : main.used,
    resetAt: main.resetAt,
    label: main.label ? `${main.label}额度` : '额度',
  };
}

function cursorMetric(q, now) {
  if (!q?.pools?.length) return null;
  const main = q.pools.find(p => p.scope === 'user' && p.limit) ?? q.pools.find(p => p.limit) ?? q.pools[0];
  const usedPercent = main.limit ? Math.min(100, (main.used / main.limit) * 100) : main.percent;
  return {
    main,
    others: q.pools.filter(p => p !== main),
    usedPercent: usedPercent ?? null,
    resetAt: q.cycleEnd,
    label: main.label,
    projection: q.cycleStart && q.cycleEnd && usedPercent != null ? project(usedPercent, q.cycleStart, q.cycleEnd, now) : null,
  };
}

export function buildSnapshot({ codex, cursor }, now = Date.now()) {
  const spend = cursor.spend(now);
  const { byConversation, ...spendSummary } = spend;
  const cursorTasks = cursor.tasks.map(t => ({ ...t, costCents: byConversation.get(t.id) ?? null }));
  const tasks = [...codex.tasks, ...cursorTasks];
  const codexQuota = codex.quota(now);
  const cursorQuota = cursor.quota(now);
  return {
    now,
    codex: {
      available: codex.available,
      error: codex.localError,
      quota: codexQuota,
      metric: codexMetric(codexQuota, now),
      stats: codex.stats.summary(now),
    },
    cursor: {
      available: cursor.available,
      error: cursor.localError,
      quota: cursorQuota,
      metric: cursorMetric(cursorQuota, now),
      spend: spendSummary,
    },
    active: tasks
      .filter(t => ACTIVE.has(t.status))
      .sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status] || (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    recent: tasks
      .filter(t => !ACTIVE.has(t.status))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
  };
}
