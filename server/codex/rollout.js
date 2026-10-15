import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { scanLines } from '../lines.js';
import { clip, clipBlock, parseJson } from '../util.js';

const MB = 1 << 20;
const LOAD_WINDOWS = [2 * MB, 8 * MB, 32 * MB];
const MAX_ACTIVITY = 40;

const TRACKED = /"type":"(?:event_msg","payload":\{"type":"(?:task_started|task_complete|turn_aborted|token_count|item_completed|thread_goal_updated|error)"|token_usage_record"|turn_context")/;
const LIFECYCLE = /"payload":\{"type":"(?:task_started|task_complete|turn_aborted)"/;

function isTracked(head) {
  if (head.includes('"item":{"type":"Reasoning"')) return false;
  if (TRACKED.test(head)) return true;
  return head.includes('"type":"response_item"') && head.includes('"name":"update_plan"');
}

function freshState(path) {
  return {
    path,
    offset: 0,
    size: 0,
    mtimeMs: 0,
    status: 'unknown',
    turn: null,
    lastTurn: null,
    model: null,
    effort: null,
    tokenInfo: null,
    contextWindow: null,
    rateLimits: null,
    lastAgentMessage: null,
    lastUserMessage: null,
    plan: null,
    goal: null,
    error: null,
    abortReason: null,
    activity: [],
    lastEventAt: 0,
  };
}

const textOf = content => (Array.isArray(content) ? content.map(c => c?.text ?? '').join('').trim() : '');

function onItem(st, it, ts) {
  let entry = null;
  switch (it.type) {
    case 'AgentMessage': {
      const text = textOf(it.content);
      if (!text) return;
      st.lastAgentMessage = { text: clipBlock(text, 3000), at: ts };
      entry = { kind: '回复', text: clip(text, 160) };
      break;
    }
    case 'UserMessage': {
      const text = textOf(it.content);
      if (!text) return;
      st.lastUserMessage = { text: clipBlock(text, 1500), at: ts };
      entry = { kind: '提问', text: clip(text, 160) };
      break;
    }
    case 'CommandExecution': {
      const cmd = Array.isArray(it.command) ? it.command[it.command.length - 1] : it.command;
      entry = { kind: '命令', text: clip(cmd, 160), failed: typeof it.exit_code === 'number' && it.exit_code !== 0 };
      break;
    }
    case 'FileChange':
      entry = { kind: '改文件', text: clip(Object.keys(it.changes ?? {}).map(f => basename(f)).join('、'), 160) };
      break;
    case 'McpToolCall':
      entry = {
        kind: '工具',
        text: clip([`${it.server}.${it.tool}`, it.arguments?.title].filter(Boolean).join(' · '), 160),
        failed: it.status === 'failed' || Boolean(it.result?.isError),
      };
      break;
    case 'WebSearch':
      entry = { kind: '搜索', text: clip(it.query ?? it.action?.query ?? '', 160) };
      break;
    case 'SubAgentActivity':
      entry = { kind: '子代理', text: clip(`${it.kind ?? ''} ${it.agent_path ?? ''}`, 160) };
      break;
    case 'ContextCompaction':
      entry = { kind: '压缩', text: '上下文已自动压缩' };
      break;
    case 'ImageView':
      entry = { kind: '看图', text: clip(basename(String(it.path ?? '')), 160) };
      break;
    default:
      return;
  }
  if (st.turn && entry.kind !== '提问' && entry.kind !== '回复') st.turn.steps += 1;
  entry.at = ts;
  st.activity.push(entry);
  if (st.activity.length > MAX_ACTIVITY) st.activity.splice(0, st.activity.length - MAX_ACTIVITY);
}

function onEvent(st, p, ts) {
  switch (p.type) {
    case 'task_started':
      st.status = 'running';
      st.turn = { id: p.turn_id ?? null, startedAt: p.started_at ? p.started_at * 1000 : ts, tokens: 0, steps: 0 };
      st.error = null;
      st.abortReason = null;
      if (p.model_context_window) st.contextWindow = p.model_context_window;
      return;
    case 'task_complete':
    case 'turn_aborted': {
      const startedAt = st.turn?.startedAt ?? (p.started_at ? p.started_at * 1000 : null);
      const endedAt = p.completed_at ? p.completed_at * 1000 : ts;
      st.lastTurn = {
        id: p.turn_id ?? st.turn?.id ?? null,
        endedAt,
        durationMs: p.duration_ms ?? (startedAt ? endedAt - startedAt : null),
        tokens: st.turn?.tokens ?? null,
        steps: st.turn?.steps ?? null,
      };
      st.status = p.type === 'task_complete' ? 'completed' : 'aborted';
      if (p.type === 'turn_aborted') st.abortReason = p.reason ?? null;
      if (p.last_agent_message) st.lastAgentMessage = { text: clipBlock(p.last_agent_message, 3000), at: ts };
      st.turn = null;
      return;
    }
    case 'token_count':
      if (p.info) st.tokenInfo = { total: p.info.total_token_usage ?? null, last: p.info.last_token_usage ?? null };
      if (p.info?.model_context_window) st.contextWindow = p.info.model_context_window;
      if (p.rate_limits) st.rateLimits = { at: ts, data: p.rate_limits };
      return;
    case 'thread_goal_updated':
      if (p.goal) st.goal = p.goal;
      return;
    case 'error':
      st.error = clip(p.message ?? '', 200);
      return;
    case 'item_completed':
      onItem(st, p.item ?? {}, ts);
  }
}

function apply(st, line) {
  const o = parseJson(line);
  if (!o || typeof o !== 'object') return;
  const ts = Date.parse(o.timestamp) || 0;
  const p = o.payload ?? {};
  if (ts > st.lastEventAt) st.lastEventAt = ts;
  switch (o.type) {
    case 'turn_context':
      st.model = p.model ?? st.model;
      st.effort = p.collaboration_mode?.settings?.reasoning_effort ?? p.effort ?? st.effort;
      return;
    case 'token_usage_record':
      if (st.turn && p.turn_token_usage) st.turn.tokens = p.turn_token_usage.total_tokens ?? st.turn.tokens;
      return;
    case 'response_item':
      if (p.type === 'function_call' && p.name === 'update_plan') {
        const plan = parseJson(p.arguments)?.plan;
        if (Array.isArray(plan)) st.plan = { at: ts, steps: plan.map(s => ({ text: clip(s.step, 120), status: s.status })) };
      }
      return;
    case 'event_msg':
      onEvent(st, p, ts);
  }
}

/**
 * Follows Codex rollout JSONL files. The first read only looks at the tail of the file (growing
 * the window until the latest turn boundary is found); afterwards only appended bytes are read.
 */
export class RolloutTracker {
  constructor() {
    this.files = new Map();
    this.inflight = new Map();
  }

  get(path) {
    return this.files.get(path) ?? null;
  }

  update(path) {
    if (!path) return Promise.resolve(null);
    if (!this.inflight.has(path)) {
      this.inflight.set(path, this.#update(path).finally(() => this.inflight.delete(path)));
    }
    return this.inflight.get(path);
  }

  prune(keep) {
    for (const path of this.files.keys()) if (!keep.has(path)) this.files.delete(path);
  }

  async #update(path) {
    let info;
    try {
      info = await stat(path);
    } catch {
      return this.files.get(path) ?? null;
    }
    let st = this.files.get(path);
    if (!st || info.size < st.offset || info.size - st.offset > 64 * MB) {
      st = await this.#load(path, info.size);
      this.files.set(path, st);
    } else if (info.size > st.offset) {
      st.offset = await scanLines(path, st.offset, isTracked, line => apply(st, line));
    }
    st.size = info.size;
    st.mtimeMs = info.mtimeMs;
    return st;
  }

  async #load(path, size) {
    for (const win of LOAD_WINDOWS) {
      const start = Math.max(0, size - win);
      const lines = [];
      const offset = await scanLines(path, start, isTracked, line => lines.push(line), { skipFirst: start > 0 });
      const last = win === LOAD_WINDOWS[LOAD_WINDOWS.length - 1];
      if (start === 0 || last || lines.some(l => LIFECYCLE.test(l.slice(0, 400)))) {
        const st = freshState(path);
        for (const line of lines) apply(st, line);
        st.offset = offset;
        return st;
      }
    }
    return freshState(path);
  }
}
