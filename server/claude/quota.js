import { fetchJson } from '../util.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// Same windows the Claude Code /usage panel reads. utilization on this endpoint is a percent.
const WINDOWS = [
  ['five_hour', 5 * 3600],
  ['seven_day', 7 * 86400],
  ['seven_day_opus', 7 * 86400],
  ['seven_day_sonnet', 7 * 86400],
  ['seven_day_oauth_apps', 7 * 86400],
  ['seven_day_cowork', 7 * 86400],
];

function liveWindow(id, windowSeconds, w) {
  if (!w || w.utilization == null) return null;
  const resetAt = Date.parse(w.resets_at);
  return {
    id,
    usedPercent: Number(w.utilization),
    windowSeconds,
    resetAt: Number.isFinite(resetAt) ? resetAt : null,
  };
}

/** Reads the current access token only. A refresh would invalidate Claude Code's own login. */
export async function fetchClaudeQuota(token) {
  let body;
  try {
    body = await fetchJson(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-cli (agent-monitor)',
      },
    });
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw new Error('Claude 登录态已过期，打开 Claude Code 后会自动刷新');
    throw err;
  }
  const windows = WINDOWS.map(([id, seconds]) => liveWindow(id, seconds, body[id])).filter(Boolean);
  const extra = body.extra_usage?.is_enabled ? body.extra_usage : null;
  return {
    source: 'live',
    at: Date.now(),
    limitReached: windows.some(w => w.usedPercent >= 100),
    windows,
    extra,
  };
}
