import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchJson } from '../util.js';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function credits(c) {
  if (!c) return null;
  return {
    hasCredits: Boolean(c.has_credits),
    unlimited: Boolean(c.unlimited),
    balance: c.balance != null ? Number(c.balance) : null,
    localMessages: Array.isArray(c.approx_local_messages) ? c.approx_local_messages : null,
    cloudMessages: Array.isArray(c.approx_cloud_messages) ? c.approx_cloud_messages : null,
  };
}

function liveWindow(id, w, now) {
  if (!w) return null;
  let resetAt = w.reset_at ? w.reset_at * 1000 : null;
  if (!resetAt && w.reset_after_seconds != null) resetAt = now + w.reset_after_seconds * 1000;
  return { id, usedPercent: Number(w.used_percent ?? 0), windowSeconds: w.limit_window_seconds ?? null, resetAt };
}

function logWindow(id, w) {
  if (!w) return null;
  return {
    id,
    usedPercent: Number(w.used_percent ?? 0),
    windowSeconds: w.window_minutes ? w.window_minutes * 60 : null,
    resetAt: w.resets_at ? w.resets_at * 1000 : null,
  };
}

/**
 * Same endpoint the Codex CLI uses for its /status rate-limit panel. The access token is read
 * fresh from auth.json each time and never refreshed here: refresh tokens rotate, so refreshing
 * from a second process would log Codex itself out.
 */
export async function fetchLiveQuota(codexHome) {
  const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
  const tokens = auth?.tokens;
  if (!tokens?.access_token) {
    throw new Error(auth?.OPENAI_API_KEY ? 'Codex 用 API Key 登录，没有订阅额度' : 'Codex 未登录 ChatGPT 账号');
  }
  const headers = {
    Authorization: `Bearer ${tokens.access_token}`,
    Accept: 'application/json',
    'User-Agent': 'codex_cli_rs (agent-monitor)',
    originator: 'codex_cli_rs',
  };
  if (tokens.account_id) headers['ChatGPT-Account-Id'] = tokens.account_id;
  let body;
  try {
    body = await fetchJson(USAGE_URL, { headers });
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw new Error('Codex 登录态已过期，打开 Codex 后会自动刷新');
    throw err;
  }
  const now = Date.now();
  const rl = body.rate_limit ?? {};
  return {
    source: 'live',
    at: now,
    planType: body.plan_type ?? null,
    limitReached: Boolean(rl.limit_reached) || rl.allowed === false,
    windows: [liveWindow('primary', rl.primary_window, now), liveWindow('secondary', rl.secondary_window, now)].filter(Boolean),
    credits: credits(body.credits),
  };
}

/** Rate-limit snapshot that Codex writes into rollout files after every model response. */
export function quotaFromLog(snapshot) {
  const rl = snapshot.data ?? {};
  return {
    source: 'log',
    at: snapshot.at,
    planType: rl.plan_type ?? null,
    limitReached: Boolean(rl.rate_limit_reached_type),
    windows: [logWindow('primary', rl.primary), logWindow('secondary', rl.secondary)].filter(Boolean),
    credits: credits(rl.credits),
  };
}
