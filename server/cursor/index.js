import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tailLines } from '../lines.js';
import { clip, clipBlock, DAY, dayKey, decodeJwt, errorText, HOUR, lastDays, parseJson, projectName, toText } from '../util.js';
import { cursorClient } from './api.js';

const AUTH_KEYS = [
  'cursorAuth/accessToken',
  'cursorAuth/cachedEmail',
  'cursorAuth/stripeMembershipType',
  'cursorAuth/cachedTeam',
  'cursorAuth/cachedScopedProfile',
];

function userQuery(text) {
  const m = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);
  return (m ? m[1] : text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ')).trim();
}

const toolArgs = v => (typeof v === 'string' ? parseJson(v, {}) : v ?? {}) || {};

function toolAction(t, at) {
  const args = { ...toolArgs(t.params), ...toolArgs(t.rawArgs) };
  const file = args.relativeWorkspacePath ?? args.path ?? args.target_file ?? args.file_path ?? args.targetFile;
  const name = String(t.name ?? '');
  let kind = '工具';
  let text = name;
  if (/terminal|shell|command/.test(name)) {
    kind = '命令';
    text = args.command ?? '';
  } else if (/edit|write|replace|delete_file|create_file/.test(name)) {
    kind = '改文件';
    text = file ? basename(String(file)) : '';
  } else if (/read_file|read_lints/.test(name)) {
    kind = '读文件';
    text = file ? basename(String(file)) : '';
  } else if (/search|grep|glob|list_dir/.test(name)) {
    kind = '搜索';
    text = args.query ?? args.pattern ?? args.search_term ?? args.glob_pattern ?? args.globPattern ?? '';
  } else if (/todo/.test(name)) {
    kind = '待办';
    text = '更新待办';
  } else if (/task|subagent/.test(name)) {
    kind = '子代理';
    text = args.description ?? '';
  } else if (/mcp/.test(name)) {
    text = [args.server, args.toolName].filter(Boolean).join('.') || name;
  }
  return {
    kind,
    text: clip(text || name, 160),
    running: t.status === 'loading',
    failed: t.status === 'error',
    at,
  };
}

function normalizeEvent(e) {
  const t = e.tokenUsage ?? {};
  return {
    at: Number(e.timestamp) || 0,
    model: e.model || 'unknown',
    cents: Number(e.chargedCents ?? t.totalCents ?? 0) || 0,
    tokens: (t.inputTokens ?? 0) + (t.outputTokens ?? 0) + (t.cacheWriteTokens ?? 0) + (t.cacheReadTokens ?? 0),
    conversationId: e.conversationId ?? null,
  };
}

function pool(id, label, scope, u) {
  if (!u || u.enabled === false || (u.limit == null && u.used == null)) return null;
  const used = Number(u.used ?? 0);
  const limit = u.limit == null ? null : Number(u.limit);
  return {
    id,
    label,
    scope,
    used,
    limit,
    remaining: u.remaining != null ? Number(u.remaining) : (limit != null ? limit - used : null),
    percent: u.totalPercentUsed ?? (limit ? (used / limit) * 100 : null),
  };
}

export class CursorSource {
  constructor(cfg) {
    this.cfg = cfg;
    this.dbPath = join(cfg.cursorUserDir, 'globalStorage', 'state.vscdb');
    this.available = existsSync(this.dbPath);
    this.db = null;
    this.stmts = null;
    this.tasks = [];
    this.composers = new Map();
    this.transcriptIndex = new Map();
    this.transcriptIndexAt = 0;
    this.transcripts = new Map();
    this.account = null;
    this.summary = null;
    this.summaryError = null;
    this.me = null;
    this.meAt = 0;
    this.profile = null;
    this.profileAt = 0;
    this.events = { cycleStart: null, list: [], byKey: new Map(), at: 0, error: null };
    this.localError = null;
  }

  async refreshLocal() {
    if (!this.available) return;
    try {
      this.#open();
      const now = Date.now();
      await this.#indexTranscripts(now);
      const heads = this.stmts.heads.all(this.cfg.taskLimit);
      const subs = this.#subagentsByParent(now);
      const tasks = [];
      for (const h of heads) {
        const head = parseJson(toText(h.value), {});
        const info = this.#composerInfo(h.id, head);
        if (!head.name && !info.headers.length) continue;
        const transcript = await this.#transcript(h.id);
        tasks.push(this.#toTask(h.id, head, info, transcript, subs.get(h.id), now));
      }
      const ids = new Set(heads.map(h => h.id));
      for (const cache of [this.composers, this.transcripts]) {
        for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
      }
      this.tasks = tasks;
      this.localError = null;
    } catch (err) {
      this.localError = errorText(err);
      this.#close();
    }
  }

  async refreshRemote() {
    if (!this.available) return;
    let auth;
    try {
      this.#open();
      auth = this.#readAuth();
    } catch (err) {
      this.summaryError = errorText(err);
      return;
    }
    if (!auth.token || !auth.userId) {
      this.summaryError = 'Cursor 未登录';
      return;
    }
    this.account = auth.account;
    const api = cursorClient(auth.token, auth.userId);
    const now = Date.now();
    try {
      this.summary = { at: now, data: await api.usageSummary() };
      this.summaryError = null;
    } catch (err) {
      this.summaryError = err.status === 401 || err.status === 403 ? 'Cursor 登录态失效，请在 Cursor 里重新登录' : errorText(err);
    }
    if (!this.me || now - this.meAt > 6 * HOUR) {
      try {
        this.me = await api.me();
        this.meAt = now;
      } catch { /* optional: only used to filter usage events to this user */ }
    }
    if (!this.profile || now - this.profileAt > HOUR) {
      try {
        this.profile = await api.stripeProfile();
        this.profileAt = now;
      } catch { /* optional: team id for usage events */ }
    }
    await this.#refreshEvents(api, now);
  }

  quota() {
    const s = this.summary?.data;
    if (!s) {
      return { source: 'none', pools: [], error: this.summaryError ?? (this.available ? '正在获取额度…' : '未检测到 Cursor') };
    }
    const iu = s.individualUsage ?? {};
    const tu = s.teamUsage ?? {};
    const pools = [
      pool('plan', '套餐内额度', 'user', iu.plan),
      pool('overall', '个人额度', 'user', iu.overall),
      pool('onDemand', '个人按需额度', 'user', iu.onDemand),
      pool('teamPlan', '团队套餐额度', 'team', tu.plan),
      pool('teamOnDemand', '团队按需池', 'team', tu.onDemand),
      pool('teamPooled', '团队共享池', 'team', tu.pooled),
    ].filter(Boolean);
    return {
      source: 'live',
      at: this.summary.at,
      error: this.summaryError,
      membership: s.membershipType ?? this.account?.membership ?? null,
      team: this.account?.team ?? null,
      limitType: s.limitType ?? null,
      unlimited: Boolean(s.isUnlimited),
      cycleStart: Date.parse(s.billingCycleStart) || null,
      cycleEnd: Date.parse(s.billingCycleEnd) || null,
      pools,
    };
  }

  spend(now = Date.now()) {
    const days = lastDays(7, now);
    const byDay = Object.fromEntries(days.map(d => [d, 0]));
    const byConversation = new Map();
    const byModel = new Map();
    const today = dayKey(now);
    let totalCents = 0;
    let todayCents = 0;
    for (const e of this.events.list) {
      totalCents += e.cents;
      const d = dayKey(e.at);
      if (d in byDay) byDay[d] += e.cents;
      if (d === today) todayCents += e.cents;
      if (e.conversationId) byConversation.set(e.conversationId, (byConversation.get(e.conversationId) ?? 0) + e.cents);
      byModel.set(e.model, (byModel.get(e.model) ?? 0) + e.cents);
    }
    return {
      ready: this.events.at > 0,
      at: this.events.at,
      error: this.events.error,
      count: this.events.list.length,
      totalCents,
      todayCents,
      daily: days.map(date => ({ date, cents: byDay[date] })),
      models: [...byModel].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([model, cents]) => ({ model, cents })),
      byConversation,
    };
  }

  detail(id) {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return null;
    const info = this.composers.get(id)?.info ?? {};
    let live = { messages: [], actions: [] };
    try {
      this.#open();
      live = this.#conversation(id, info.headers ?? []);
    } catch {
      // fall back to the transcript file below
    }
    return {
      task,
      todos: info.todos ?? [],
      contextTokens: info.contextTokens ?? null,
      contextLimit: info.contextLimit ?? null,
      messages: live.messages.length ? live.messages : (this.transcripts.get(id)?.messages ?? []).slice().reverse(),
      actions: live.actions,
      events: this.events.list.filter(e => e.conversationId === id).slice(0, 30),
    };
  }

  #open() {
    if (this.db) return;
    this.db = new DatabaseSync(this.dbPath, { readOnly: true });
    this.stmts = {
      heads: this.db.prepare('select composerId as id, value from composerHeaders where isArchived = 0 and isSubagent = 0 order by recency desc limit ?'),
      subHeads: this.db.prepare('select value from composerHeaders where isSubagent = 1 and lastUpdatedAt > ?'),
      composer: this.db.prepare('select value from cursorDiskKV where key = ?'),
      auth: this.db.prepare(`select key, value from ItemTable where key in (${AUTH_KEYS.map(() => '?').join(',')})`),
    };
  }

  #close() {
    try { this.db?.close(); } catch { /* already closed */ }
    this.db = null;
    this.stmts = null;
  }

  /** The IDE keeps this token fresh; it is only ever sent to cursor.com, never to the browser. */
  #readAuth() {
    const kv = Object.fromEntries(this.stmts.auth.all(...AUTH_KEYS).map(r => [r.key, toText(r.value)]));
    const token = kv['cursorAuth/accessToken'] || null;
    const sub = token ? decodeJwt(token)?.sub : null;
    const team = parseJson(kv['cursorAuth/cachedTeam']);
    return {
      token,
      userId: sub ? String(sub).split('|').pop() : null,
      account: {
        email: kv['cursorAuth/cachedEmail'] || null,
        membership: kv['cursorAuth/stripeMembershipType'] || null,
        team: team?.name ?? null,
        teamId: team?.teamId ?? null,
      },
    };
  }

  async #refreshEvents(api, now) {
    const cycleStart = Date.parse(this.summary?.data?.billingCycleStart ?? '') || new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();
    if (this.events.cycleStart !== cycleStart) {
      this.events = { cycleStart, list: [], byKey: new Map(), at: 0, error: null };
    }
    const teamId = this.profile?.teamId ?? this.account?.teamId ?? null;
    const myId = this.me?.id != null ? String(this.me.id) : null;
    try {
      for (let page = 1; page <= 40; page++) {
        const body = { startDate: String(cycleStart), endDate: String(now), page, pageSize: 100 };
        if (teamId) body.teamId = teamId;
        const items = (await api.usageEvents(body)).usageEventsDisplay ?? [];
        let fresh = 0;
        for (const e of items) {
          // An agent run is a single event whose cost keeps growing until the run ends, so the
          // key must not include the amount; known events are updated in place.
          const key = `${e.timestamp}|${e.model}|${e.conversationId ?? ''}`;
          const ev = normalizeEvent(e);
          const existing = this.events.byKey.get(key);
          if (existing) {
            Object.assign(existing, ev);
            continue;
          }
          fresh += 1;
          this.events.byKey.set(key, ev);
          if (!myId || !e.owningUser || String(e.owningUser) === myId) this.events.list.push(ev);
        }
        if (!fresh || items.length < body.pageSize) break;
      }
      this.events.list.sort((a, b) => b.at - a.at);
      this.events.at = now;
      this.events.error = null;
    } catch (err) {
      this.events.error = errorText(err);
    }
  }

  #subagentsByParent(now) {
    const out = new Map();
    for (const row of this.stmts.subHeads.all(now - 6 * HOUR)) {
      const head = parseJson(toText(row.value), {});
      const parent = head.subagentInfo?.parentComposerId;
      if (!parent) continue;
      const entry = out.get(parent) ?? { total: 0, running: 0 };
      entry.total += 1;
      if (head.unfinishedRunAt && now - (head.lastUpdatedAt ?? 0) < this.cfg.stalledAfterMs) entry.running += 1;
      out.set(parent, entry);
    }
    return out;
  }

  /** composerData blobs can be megabytes; re-read one only when its header says it changed. */
  #composerInfo(id, head) {
    const stamp = [head.lastUpdatedAt, head.conversationCheckpointLastUpdatedAt, head.unfinishedRunAt, head.hasBlockingPendingActions].join('|');
    const cached = this.composers.get(id);
    if (cached?.stamp === stamp) return cached.info;
    const row = this.stmts.composer.get(`composerData:${id}`);
    const d = row ? parseJson(toText(row.value), {}) : {};
    const selected = d.modelConfig?.selectedModels?.[0];
    const headers = Array.isArray(d.fullConversationHeadersOnly) ? d.fullConversationHeadersOnly : [];
    const info = {
      headers: headers.slice(-120).map(h => ({ id: h.bubbleId, type: h.type })),
      status: d.status ?? null,
      todos: Array.isArray(d.todos) ? d.todos.map(t => ({ text: clip(t.content, 120), status: t.status })) : [],
      model: d.modelConfig?.modelName ?? selected?.modelId ?? null,
      maxMode: Boolean(d.modelConfig?.maxMode),
      effort: selected?.parameters?.find(p => p.id === 'effort')?.value ?? null,
      contextTokens: d.contextTokensUsed ?? null,
      contextLimit: d.contextTokenLimit ?? null,
      contextPercent: d.contextUsagePercent ?? null,
    };
    this.composers.set(id, { stamp, info });
    return info;
  }

  #bubble(id, bubbleId) {
    const row = this.stmts.composer.get(`bubbleId:${id}:${bubbleId}`);
    return row ? parseJson(toText(row.value)) : null;
  }

  /**
   * Chat bubbles are written as they stream, unlike transcript files which lag behind a running
   * turn. Walks back from the newest bubble; returns newest-first lists.
   */
  #conversation(id, headers, maxMessages = 8, maxActions = 15) {
    const messages = [];
    const actions = [];
    for (let i = headers.length - 1, looked = 0; i >= 0 && looked < 80; i--, looked++) {
      if (messages.length >= maxMessages && actions.length >= maxActions) break;
      const b = this.#bubble(id, headers[i].id);
      if (!b) continue;
      const at = Date.parse(b.createdAt) || null;
      const text = typeof b.text === 'string' ? b.text.trim() : '';
      if (text && messages.length < maxMessages) {
        messages.push(headers[i].type === 1
          ? { role: 'user', text: clipBlock(userQuery(text), 600), at }
          : { role: 'assistant', text: clipBlock(text, 800), at });
      }
      if (b.toolFormerData?.name && actions.length < maxActions) actions.push(toolAction(b.toolFormerData, at));
    }
    return { messages, actions };
  }

  #currentAction(id, headers) {
    for (let i = headers.length - 1; i >= 0 && i >= headers.length - 6; i--) {
      const b = this.#bubble(id, headers[i].id);
      if (b?.toolFormerData?.name) {
        const a = toolAction(b.toolFormerData, null);
        return `${a.kind}：${a.text}${a.running ? '（进行中）' : ''}`;
      }
      const text = typeof b?.text === 'string' ? b.text.trim() : '';
      if (text) return `${headers[i].type === 1 ? '提问' : '回复'}：${clip(text, 120)}`;
    }
    return null;
  }

  async #indexTranscripts(now) {
    if (now - this.transcriptIndexAt < 30_000) return;
    this.transcriptIndexAt = now;
    const root = join(this.cfg.cursorHome, 'projects');
    const index = new Map();
    let projects = [];
    try {
      projects = await readdir(root);
    } catch {
      this.transcriptIndex = index;
      return;
    }
    for (const project of projects) {
      const dir = join(root, project, 'agent-transcripts');
      let entries;
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (name.endsWith('.jsonl')) index.set(name.slice(0, -6), join(dir, name));
        else index.set(name, join(dir, name, `${name}.jsonl`));
      }
    }
    this.transcriptIndex = index;
  }

  async #transcript(id) {
    const path = this.transcriptIndex.get(id);
    if (!path) return null;
    let s;
    try {
      s = await stat(path);
    } catch {
      return null;
    }
    const cached = this.transcripts.get(id);
    if (cached && cached.mtimeMs === s.mtimeMs && cached.size === s.size) return cached;
    const messages = [];
    let lastAssistant = null;
    let turnEnded = null;
    for (const line of await tailLines(path, s.size, 256 * 1024)) {
      const o = parseJson(line);
      if (!o) continue;
      if (o.type === 'turn_ended') {
        turnEnded = { status: o.status ?? null, error: o.error ?? null };
        continue;
      }
      const text = (o.message?.content ?? []).filter(c => c?.type === 'text').map(c => c.text).join('\n').trim();
      if (!text) continue;
      turnEnded = null;
      if (o.role === 'assistant') {
        lastAssistant = text;
        messages.push({ role: 'assistant', text: clipBlock(text, 1200) });
      } else if (o.role === 'user') {
        messages.push({ role: 'user', text: clipBlock(userQuery(text), 600) });
      }
    }
    const result = { mtimeMs: s.mtimeMs, size: s.size, lastAssistant, turnEnded, messages: messages.slice(-12) };
    this.transcripts.set(id, result);
    return result;
  }

  #status(head, info, transcript, now) {
    const lastActive = Math.max(head.lastUpdatedAt ?? 0, head.conversationCheckpointLastUpdatedAt ?? 0, transcript?.mtimeMs ?? 0);
    const recent = now - lastActive < DAY;
    if (head.hasBlockingPendingActions && recent) return { status: 'waiting', reason: '等待你确认操作', lastActive };
    if (head.unfinishedRunAt) {
      if (now - lastActive <= this.cfg.stalledAfterMs) return { status: 'running', lastActive };
      return { status: recent ? 'stalled' : 'aborted', lastActive };
    }
    if (head.hasPendingPlan && recent) return { status: 'waiting', reason: '计划等待确认', lastActive };
    if (info.status === 'error') return { status: 'error', lastActive };
    if (info.status === 'aborted' || transcript?.turnEnded?.status === 'error') return { status: 'aborted', lastActive };
    if (info.status === 'completed') return { status: 'completed', lastActive };
    return { status: 'idle', lastActive };
  }

  #toTask(id, head, info, transcript, subs, now) {
    const { status, reason, lastActive } = this.#status(head, info, transcript, now);
    const todos = info.todos.filter(t => t.status !== 'cancelled');
    const fsPath = head.workspaceIdentifier?.uri?.fsPath ?? head.workspaceIdentifier?.uri?.path ?? null;
    const location = head.agentLocation?.type ?? 'local';
    return {
      tool: 'cursor',
      id,
      title: clip(head.name || '未命名对话', 80),
      project: projectName(fsPath) || (location === 'cloud' ? '云端' : ''),
      cwd: fsPath,
      model: info.model,
      effort: info.effort,
      maxMode: info.maxMode,
      mode: head.unifiedMode ?? null,
      location,
      status,
      waitingReason: reason ?? null,
      createdAt: head.createdAt ?? null,
      updatedAt: lastActive || null,
      runStartedAt: head.unfinishedRunAt ?? null,
      runKey: head.unfinishedRunAt ? String(head.unfinishedRunAt) : null,
      progress: todos.length ? {
        done: todos.filter(t => t.status === 'completed').length,
        total: todos.length,
        current: todos.find(t => t.status === 'in_progress')?.text ?? null,
        items: todos,
      } : null,
      contextPercent: head.contextUsagePercent ?? info.contextPercent ?? null,
      lines: { added: head.totalLinesAdded ?? 0, removed: head.totalLinesRemoved ?? 0, files: head.filesChangedCount ?? 0 },
      activity: (status === 'running' || status === 'waiting' ? this.#currentAction(id, info.headers) : null)
        ?? (head.subtitle ? clip(head.subtitle, 120) : null),
      lastMessage: transcript?.lastAssistant ? clip(transcript.lastAssistant, 200) : null,
      subagents: subs ?? null,
      costCents: null,
    };
  }
}
