import { dayKey, pad } from '../util.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const TOOL = { codex: 'Codex', cursor: 'Cursor' };
export const PLAN = { prolite: 'Pro Lite', pro: 'Pro', plus: 'Plus', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', free: 'Free' };
export const REMINDER = { done: '完成', aborted: '中断', waiting: '待确认', stalled: '无响应', quota: '额度', reset: '重置' };

export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ESC[c]);
export const capitalize = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
export const join = parts => parts.filter(Boolean).join(' · ');

function fixed(v, digits) {
  const s = v.toFixed(digits);
  return digits > 0 ? s.replace(/\.?0+$/, '') : s;
}

export const num = (v, digits = 1) => (v == null || !Number.isFinite(v) ? '-' : fixed(v, digits));

export function tokens(n) {
  if (n == null || !Number.isFinite(n)) return '-';
  const a = Math.abs(n);
  if (a >= 1e9) return `${fixed(n / 1e9, 2)}B`;
  if (a >= 1e6) return `${fixed(n / 1e6, 1)}M`;
  if (a >= 1e3) return `${fixed(n / 1e3, 1)}K`;
  return String(Math.round(n));
}

export function usd(cents, { compact = false } = {}) {
  if (cents == null || !Number.isFinite(cents)) return '-';
  const v = cents / 100;
  const a = Math.abs(v);
  if (a >= 1e6) return `$${fixed(v / 1e6, 2)}M`;
  if (compact && a >= 1e4) return `$${fixed(v / 1e3, 1)}K`;
  const digits = Number.isInteger(v) || (compact && a >= 100) ? 0 : 2;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function pct(v, digits = 0) {
  if (v == null || !Number.isFinite(v)) return '-';
  return `${fixed(v, digits)}%`;
}

/** One decimal for small non-zero values so "0.4%" doesn't read as "0%". */
export const pctAuto = v => pct(v, v > 0 && v < 10 ? 1 : 0);

export function duration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} 天 ${h % 24} 小时` : `${d} 天`;
}

export const clock = ms => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const monthDay = ms => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

export const dateTime = ms => `${monthDay(ms)} ${clock(ms)}`;

/**
 * Absolute timestamps instead of "N 分钟前": a section's HTML then stays byte-identical between
 * polls, so the e-ink screen is not redrawn just because time passed.
 */
export function when(ms, now = Date.now()) {
  if (!ms) return '-';
  const day = new Date(ms).toDateString();
  if (day === new Date(now).toDateString()) return clock(ms);
  if (day === new Date(now - 86_400_000).toDateString()) return `昨天 ${clock(ms)}`;
  return `${monthDay(ms)} ${clock(ms)}`;
}

/** Rounded down to the largest unit, so long spans change at most hourly. */
export function coarse(ms) {
  if (ms == null || !Number.isFinite(ms)) return '-';
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 60) return `${Math.max(1, m)} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时`;
  const d = Math.floor(h / 24);
  return d < 3 && h % 24 ? `${d} 天 ${h % 24} 小时` : `${d} 天`;
}

export function dayLabel(key, now = Date.now()) {
  if (key === dayKey(now)) return '今天';
  if (key === dayKey(now - 86_400_000)) return '昨天';
  const [, month, day] = key.split('-');
  return `${Number(month)}/${Number(day)}`;
}

export function refreshLabel(sec) {
  return sec < 60 ? `${sec} 秒` : `${Math.round(sec / 60)} 分钟`;
}
