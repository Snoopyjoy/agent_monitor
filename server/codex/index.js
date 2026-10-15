import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { clip, errorText, HOUR, MINUTE, projectName, stripMarkup } from '../util.js';
import { fetchLiveQuota, quotaFromLog } from './quota.js';
import { RolloutTracker } from './rollout.js';
import { CodexStats } from './stats.js';

function latestVersioned(dir, pattern) {
  let best = null;
  let bestVersion = -1;
  for (const name of readdirSync(dir)) {
    const m = pattern.exec(name);
    if (m && Number(m[1]) > bestVersion) {
      best = name;
      bestVersion = Number(m[1]);
    }
  }
  return best ? join(dir, best) : null;
}

function progressFromPlan(plan) {
  const steps = plan?.steps;
  if (!steps?.length) return null;
  return {
    done: steps.filter(s => s.status === 'completed').length,
    total: steps.length,
    current: steps.find(s => s.status === 'in_progress')?.text ?? null,
    items: steps,
  };
}

export class CodexSource {
  constructor(cfg) {
    this.cfg = cfg;
    this.available = existsSync(cfg.codexHome);
    this.tracker = new RolloutTracker();
    this.stats = new CodexStats(cfg);
    this.db = null;
    this.goalsDb = null;
    this.cols = new Set();
    this.tasks = [];
    this.rows = new Map();
    this.subagents = new Map();
    this.live = null;
    this.liveError = null;
    this.localError = null;
    this.models = new Map();
    this.stats.modelHint = id => this.models.get(id) ?? null;
  }

  async refreshLocal() {
    if (!this.available) return;
    try {
      this.#open();
      const now = Date.now();
      const rows = this.#queryThreads();
      const goals = this.#queryGoals();
      const children = this.#querySubagents(rows.map(r => r.id));
      const recentChildren = children.filter(c => now - (c.recency_ms ?? 0) < 2 * HOUR);
      const [states, childStates] = await Promise.all([
        Promise.all(rows.map(r => this.tracker.update(r.rollout_path).catch(() => null))),
        Promise.all(recentChildren.map(c => this.tracker.update(c.rollout_path).catch(() => null))),
      ]);
      const childStatus = new Map(recentChildren.map((c, i) => [c.id, this.#status(childStates[i], c, now)]));
      const subagents = new Map();
      for (const c of children) {
        const list = subagents.get(c.parent) ?? [];
        list.push({
          id: c.id,
          name: c.agent_nickname || c.agent_role || '子代理',
          role: c.agent_role ?? null,
          model: c.model ?? null,
          tokens: c.tokens_used ?? null,
          updatedAt: c.recency_ms ?? null,
          status: childStatus.get(c.id) ?? 'completed',
        });
        subagents.set(c.parent, list);
      }
      this.rows = new Map(rows.map(r => [r.id, r]));
      this.subagents = subagents;
      for (const r of rows) if (r.model) this.models.set(r.id, r.model);
      this.tasks = rows.map((r, i) => this.#toTask(r, states[i], goals.get(r.id), subagents.get(r.id), now));
      this.tracker.prune(new Set([...rows, ...recentChildren].map(r => r.rollout_path)));
      this.localError = null;
    } catch (err) {
      this.localError = errorText(err);
      this.#close();
    }
  }

  async refreshRemote() {
    if (!this.available) return;
    try {
      this.live = await fetchLiveQuota(this.cfg.codexHome);
      this.liveError = null;
    } catch (err) {
      this.liveError = errorText(err);
    }
  }

  /** Prefers the live API; falls back to the newest rate-limit snapshot found in rollout logs. */
  quota(now = Date.now()) {
    let log = this.stats.latestRateLimits;
    for (const st of this.tracker.files.values()) {
      if (st.rateLimits && (!log || st.rateLimits.at > log.at)) log = st.rateLimits;
    }
    const liveFresh = this.live && now - this.live.at < 15 * MINUTE;
    let q = this.live;
    if (!liveFresh && log && (!this.live || log.at > this.live.at)) q = quotaFromLog(log);
    if (!q) return { source: 'none', windows: [], credits: null, error: this.liveError ?? '暂无额度数据' };
    return { ...q, error: this.liveError };
  }

  detail(id) {
    const row = this.rows.get(id);
    const task = this.tasks.find(t => t.id === id);
    if (!row || !task) return null;
    const st = this.tracker.get(row.rollout_path);
    return {
      task,
      activity: (st?.activity ?? []).slice(-20).reverse(),
      lastMessage: st?.lastAgentMessage ?? null,
      lastPrompt: st?.lastUserMessage ?? null,
      plan: st?.plan ?? null,
      tokenInfo: st?.tokenInfo ?? null,
      contextWindow: st?.contextWindow ?? null,
      subagents: this.subagents.get(id) ?? [],
    };
  }

  #status(st, row, now) {
    let status = st?.status ?? 'idle';
    if (status === 'unknown') status = 'idle';
    const lastWrite = st?.mtimeMs || row.recency_ms || 0;
    if (status === 'running' && now - lastWrite > this.cfg.stalledAfterMs) status = 'stalled';
    return status;
  }

  #toTask(r, st, goal, subs, now) {
    const status = this.#status(st, r, now);
    const title = clip(r.name || stripMarkup(r.title) || stripMarkup(r.preview) || stripMarkup(r.first_user_message) || '未命名任务', 80);
    const lastInput = st?.tokenInfo?.last?.input_tokens;
    const lastAct = st?.activity?.[st.activity.length - 1];
    const g = goal ?? (st?.goal ? {
      objective: st.goal.objective,
      status: st.goal.status,
      tokens_used: st.goal.tokensUsed,
      token_budget: st.goal.tokenBudget,
      time_used_seconds: st.goal.timeUsedSeconds,
    } : null);
    return {
      tool: 'codex',
      id: r.id,
      title,
      project: projectName(r.cwd),
      cwd: r.cwd,
      model: st?.model || r.model || null,
      effort: st?.effort || r.reasoning_effort || null,
      status,
      createdAt: r.created_ms ?? null,
      updatedAt: Math.max(r.recency_ms ?? 0, st?.lastEventAt ?? 0) || null,
      runStartedAt: st?.turn?.startedAt ?? null,
      runKey: st?.turn?.id ?? st?.lastTurn?.id ?? (st?.lastTurn?.endedAt ? String(st.lastTurn.endedAt) : null),
      lastRun: st?.lastTurn ?? null,
      turnTokens: st?.turn?.tokens ?? null,
      turnSteps: st?.turn?.steps ?? null,
      tokens: r.tokens_used ?? null,
      contextPercent: st?.contextWindow && lastInput ? Math.min(100, (lastInput / st.contextWindow) * 100) : null,
      progress: progressFromPlan(st?.plan),
      goal: g ? {
        objective: clip(g.objective, 200),
        status: g.status,
        tokensUsed: g.tokens_used ?? null,
        tokenBudget: g.token_budget ?? null,
        seconds: g.time_used_seconds ?? null,
      } : null,
      activity: lastAct ? `${lastAct.kind}：${lastAct.text}` : null,
      lastMessage: st?.lastAgentMessage ? clip(st.lastAgentMessage.text, 200) : null,
      abortReason: st?.abortReason ?? null,
      error: st?.error ?? null,
      subagents: subs?.length ? { total: subs.length, running: subs.filter(s => s.status === 'running').length } : null,
      branch: r.git_branch ?? null,
    };
  }

  #open() {
    if (this.db) return;
    const path = latestVersioned(this.cfg.codexHome, /^state_(\d+)\.sqlite$/);
    if (!path) throw new Error('找不到 Codex 状态库（~/.codex/state_*.sqlite）');
    this.db = new DatabaseSync(path, { readOnly: true });
    this.cols = new Set(this.db.prepare('pragma table_info(threads)').all().map(c => c.name));
    const goals = latestVersioned(this.cfg.codexHome, /^goals_(\d+)\.sqlite$/);
    if (goals) {
      try {
        this.goalsDb = new DatabaseSync(goals, { readOnly: true });
      } catch {
        this.goalsDb = null;
      }
    }
  }

  #close() {
    try { this.db?.close(); } catch { /* already closed */ }
    try { this.goalsDb?.close(); } catch { /* already closed */ }
    this.db = null;
    this.goalsDb = null;
  }

  #col(name) {
    return this.cols.has(name) ? name : `null as ${name}`;
  }

  #timeExprs() {
    const has = c => this.cols.has(c);
    const recency = has('recency_at_ms')
      ? 'coalesce(nullif(recency_at_ms, 0), updated_at_ms, updated_at * 1000)'
      : has('updated_at_ms') ? 'coalesce(updated_at_ms, updated_at * 1000)' : 'updated_at * 1000';
    const created = has('created_at_ms') ? 'coalesce(created_at_ms, created_at * 1000)' : 'created_at * 1000';
    return { recency, created };
  }

  #queryThreads() {
    const { recency, created } = this.#timeExprs();
    const notSubagent = this.cols.has('thread_source')
      ? "coalesce(thread_source, '') <> 'subagent'"
      : `source not like '{"subagent"%'`;
    const hasUser = this.cols.has('has_user_event') ? 'and (has_user_event = 1 or tokens_used > 0)' : '';
    const sql = `select id, rollout_path, cwd, title, tokens_used, ${this.#col('name')}, ${this.#col('preview')},
        ${this.#col('first_user_message')}, ${this.#col('model')}, ${this.#col('reasoning_effort')}, ${this.#col('git_branch')},
        ${created} as created_ms, ${recency} as recency_ms
      from threads where archived = 0 and ${notSubagent} ${hasUser}
      order by recency_ms desc limit ?`;
    return this.db.prepare(sql).all(this.cfg.taskLimit);
  }

  #querySubagents(parentIds) {
    if (!parentIds.length) return [];
    const { recency } = this.#timeExprs();
    try {
      return this.db.prepare(`select e.parent_thread_id as parent, t.id, t.rollout_path, t.tokens_used,
          ${this.#col('agent_nickname')}, ${this.#col('agent_role')}, ${this.#col('model')}, ${recency} as recency_ms
        from thread_spawn_edges e join threads t on t.id = e.child_thread_id
        where e.parent_thread_id in (${parentIds.map(() => '?').join(',')})`).all(...parentIds);
    } catch {
      return [];
    }
  }

  #queryGoals() {
    if (!this.goalsDb) return new Map();
    try {
      const rows = this.goalsDb.prepare('select thread_id, objective, status, token_budget, tokens_used, time_used_seconds from thread_goals').all();
      return new Map(rows.map(r => [r.thread_id, r]));
    } catch {
      return new Map();
    }
  }
}
