import { capitalize, coarse, clock, dayLabel, duration, esc, join, monthDay, num, pct, pctAuto, PLAN, refreshLabel, REMINDER, tokens, TOOL, usd, when } from './format.js';

const STATUS = {
  running: ['运行中', 'inv'],
  waiting: ['待确认', 'inv'],
  stalled: ['无响应', 'inv'],
  completed: ['完成', ''],
  aborted: ['中断', ''],
  error: ['出错', ''],
  idle: ['空闲', 'dim'],
};
const STEP = {
  completed: ['完成', ''],
  in_progress: ['进行', 'inv'],
  pending: ['待办', 'dim'],
  cancelled: ['取消', 'dim'],
};
const GOAL = { active: '进行中', paused: '已暂停', blocked: '受阻', usage_limited: '额度不足', budget_limited: '预算用尽', complete: '已完成' };
const ABORT = { interrupted: '手动中断', replaced: '被新请求替换' };
const MODE = { agent: 'Agent', chat: 'Ask', plan: 'Plan', debug: 'Debug', background: 'Background' };

const tag = (text, cls = '') => `<span class="tag${cls ? ` ${cls}` : ''}">${esc(text)}</span>`;
const statusTag = s => tag(...(STATUS[s] ?? [s, '']));
const taskHref = (tool, id) => `/task/${tool}/${encodeURIComponent(id)}`;
const clampPct = v => Math.max(0, Math.min(100, Number(v) || 0)).toFixed(1);
const bar = remaining => `<div class="bar"><div style="width:${clampPct(remaining)}%"></div></div>`;
const lines = (list, cls) => list.filter(Boolean).map(l => `<div class="${cls}">${l}</div>`).join('');
const block = (title, html) => (html ? `<h2>${title}</h2>${html}` : '');

function modelText(t) {
  return join([t.model, t.effort && `推理 ${t.effort}`, t.maxMode && 'MAX 模式']);
}

function activityTable(list, now) {
  if (!list?.length) return '';
  const rows = list.map(a => `<tr><td class="st">${tag(a.kind)}</td><td>${esc(a.text) || '-'}`
    + `${a.failed ? ' <b>（失败）</b>' : ''}${a.running ? ' <b>（进行中）</b>' : ''}<div class="meta">${when(a.at, now)}</div></td></tr>`);
  return `<table class="rows">${rows.join('')}</table>`;
}

function progressText(p) {
  if (!p) return '';
  const fill = p.total ? (p.done / p.total) * 100 : 0;
  return `进度 ${p.done}/${p.total} <span class="pbar"><span style="width:${clampPct(fill)}%"></span></span>${p.current ? ` ${esc(p.current)}` : ''}`;
}

function stepTable(items) {
  if (!items?.length) return '';
  const rows = items.map(s => `<tr><td class="st">${tag(...(STEP[s.status] ?? [s.status, '']))}</td><td>${esc(s.text)}</td></tr>`);
  return `<table class="rows">${rows.join('')}</table>`;
}

function projectionText(projection, now, endText) {
  if (!projection) return '';
  if (projection.exhaustAt) return `<b>按当前速度，约 ${when(projection.exhaustAt, now)} 用完</b>`;
  return `按当前速度，${endText(projection.atEnd)}`;
}

function codexQuota(c, now) {
  const q = c.quota;
  const m = c.metric;
  const plan = q.planType ? PLAN[q.planType] ?? capitalize(q.planType) : '';
  const head = `<div class="qh">CODEX${plan ? ` <span class="sub">${esc(plan)}</span>` : ''}</div>`;
  if (!c.available) return `${head}<div class="qs">未检测到 Codex（~/.codex）</div>`;
  if (!m) return `${head}<div class="big">--</div>${lines([esc(q.error ?? '暂无额度数据')], 'qs')}`;
  const w = m.main;
  const info = [
    q.limitReached && '<b>已触发限额</b>',
    join([`已用 ${pctAuto(w.used)}`, w.resetAt && `${when(w.resetAt, now)} 重置（${coarse(w.resetAt - now)}后）`]),
    ...m.windows.filter(o => o !== w).map(o => join([`${esc(o.label)}额度剩余 ${pctAuto(o.remaining)}`, o.resetAt && `${coarse(o.resetAt - now)}后重置`])),
    projectionText(w.projection, now, v => `重置前约用到 ${pct(Math.min(100, v))}`),
  ];
  const cr = q.credits;
  if (cr && !cr.unlimited && cr.balance != null && (cr.hasCredits || cr.balance > 0)) {
    const msgs = cr.localMessages ? `（约 ${cr.localMessages[0]}–${cr.localMessages[1]} 条本地消息）` : '';
    info.push(`Credits 余额 ${num(cr.balance)}${msgs}`);
  }
  if (q.source === 'log') info.push(`<span class="dim">实时接口暂不可用，显示 ${when(q.at, now)} 的日志数据</span>`);
  if (q.error) info.push(`<span class="dim">${esc(q.error)}</span>`);
  return `${head}<div class="ql">${esc(w.label)}额度剩余</div><div class="big">${pctAuto(w.remaining)}</div>${bar(w.remaining)}${lines(info, 'qs')}`;
}

function cursorQuota(c, now) {
  const q = c.quota;
  const m = c.metric;
  const sub = join([q.membership && esc(capitalize(q.membership)), q.team && esc(q.team)]);
  const head = `<div class="qh">CURSOR${sub ? ` <span class="sub">${sub}</span>` : ''}</div>`;
  if (!c.available) return `${head}<div class="qs">未检测到 Cursor</div>`;
  if (q.unlimited) return `${head}<div class="ql">额度</div><div class="big">不限量</div>`;
  if (!m) return `${head}<div class="big">--</div>${lines([esc(q.error ?? '暂无额度数据')], 'qs')}`;
  const p = m.main;
  const info = [];
  let top;
  if (p.limit) {
    top = `<div class="ql">${esc(p.label)}剩余</div><div class="big">${usd(p.remaining)}</div>${bar(100 - m.usedPercent)}`;
    info.push(`已用 ${usd(p.used)} / ${usd(p.limit)}（${pctAuto(m.usedPercent)}）`);
  } else {
    top = `<div class="ql">${esc(p.label)}已用</div><div class="big">${usd(p.used)}</div>`;
  }
  if (q.cycleEnd) info.push(`${monthDay(q.cycleEnd)} 重置（${coarse(q.cycleEnd - now)}后）`);
  if (p.limit) info.push(projectionText(m.projection, now, v => `周期末约用 ${usd((p.limit * v) / 100)}（${pct(v)}）`));
  const sp = c.spend;
  if (sp.ready) info.push(`今日 ${usd(sp.todayCents)} · 本周期 ${sp.count} 次请求`);
  for (const o of m.others) {
    info.push(`<span class="dim">${esc(o.label)} 已用 ${usd(o.used, { compact: true })}${o.limit ? ` / ${usd(o.limit, { compact: true })}` : ''}</span>`);
  }
  if (q.error) info.push(`<span class="dim">${esc(q.error)}</span>`);
  return `${head}${top}${lines(info, 'qs')}`;
}

function quotaSection(snap) {
  return `<table class="quota"><tr><td class="q">${codexQuota(snap.codex, snap.now)}</td><td class="q">${cursorQuota(snap.cursor, snap.now)}</td></tr></table>`;
}

function reminderRow(r, now) {
  const title = r.taskId ? `<a href="${taskHref(r.tool, r.taskId)}">${esc(r.title)}</a>` : `<b>${esc(r.title)}</b>`;
  const meta = join([TOOL[r.tool], r.project && esc(r.project), esc(r.text), when(r.at, now)]);
  return `<tr><td class="st">${tag(REMINDER[r.kind] ?? r.kind, r.read ? '' : 'inv')}</td><td>${title}<div class="meta">${meta}</div></td></tr>`;
}

const ackForm = back => `<form method="post" action="/ack" data-xhr="1"><input type="hidden" name="back" value="${esc(back)}"><button type="submit">全部已读</button></form>`;

function alertsSection(unread, now) {
  if (!unread.length) return '';
  const more = unread.length > 5 ? `<div class="meta"><a href="/reminders">还有 ${unread.length - 5} 条未读</a></div>` : '';
  return `<div class="alerts"><table><tr><td><b>新提醒 ${unread.length}</b></td><td class="r">${ackForm('/')}</td></tr></table>`
    + `<table class="rows">${unread.slice(0, 5).map(r => reminderRow(r, now)).join('')}</table>${more}</div>`;
}

function taskCard(t, now) {
  const meta = join([TOOL[t.tool], t.project && esc(t.project), t.location === 'cloud' && '云端', t.runStartedAt && `已运行 ${coarse(now - t.runStartedAt)}`]);
  const info = [
    t.status === 'waiting' && `<b>${esc(t.waitingReason ?? '等待你确认')}</b>`,
    t.status === 'stalled' && `<b>${coarse(now - (t.updatedAt ?? now))}没有新进展</b>`,
    progressText(t.progress),
    t.activity && esc(t.activity),
  ];
  const stats = join([
    esc(modelText(t)),
    t.turnTokens && `本轮 ${tokens(t.turnTokens)} tokens`,
    t.contextPercent != null && `上下文 ${pct(t.contextPercent)}`,
    t.subagents?.running && `子代理 ${t.subagents.running}/${t.subagents.total}`,
    t.costCents && usd(t.costCents),
  ]);
  return `<div class="task"><div class="t1">${statusTag(t.status)} ${meta}</div>`
    + `<div class="t2"><a href="${taskHref(t.tool, t.id)}">${esc(t.title)}</a></div>${lines(info, 't3')}${stats ? `<div class="meta">${stats}</div>` : ''}</div>`;
}

function activeSection(snap) {
  if (!snap.active.length) return '<h2>进行中</h2><div class="empty">当前没有运行中的任务</div>';
  return `<h2>进行中 ${snap.active.length}</h2>${snap.active.map(t => taskCard(t, snap.now)).join('')}`;
}

function recentSection(snap, limit = 12) {
  const list = snap.recent.slice(0, limit);
  if (!list.length) return '<h2>最近任务</h2><div class="empty">暂无任务记录</div>';
  const rows = list.map(t => {
    const meta = join([
      TOOL[t.tool],
      t.project && esc(t.project),
      when(t.updatedAt, snap.now),
      t.lastRun?.durationMs && `用时 ${duration(t.lastRun.durationMs)}`,
      t.progress && `待办 ${t.progress.done}/${t.progress.total}`,
      t.costCents && usd(t.costCents),
    ]);
    return `<tr><td class="st">${statusTag(t.status)}</td><td><a href="${taskHref(t.tool, t.id)}">${esc(t.title)}</a><div class="meta">${meta}</div></td></tr>`;
  });
  return `<h2>最近任务</h2><table class="rows">${rows.join('')}</table>`;
}

function usageSection(snap) {
  const { codex, cursor, now } = snap;
  const st = codex.stats;
  const sp = cursor.spend;
  const showCodex = codex.available;
  const showCursor = cursor.available;
  if (!showCodex && !showCursor) return '';
  const cents = Object.fromEntries(sp.daily.map(d => [d.date, d.cents]));
  const cycleStart = cursor.quota.cycleStart;
  const beforeCycle = date => cycleStart && new Date(`${date}T23:59:59`).getTime() < cycleStart;
  const head = `<tr><th></th>${showCodex ? '<th class="num">Codex tokens</th>' : ''}${showCursor ? '<th class="num">Cursor 花费</th>' : ''}</tr>`;
  const row = (label, codexValue, cursorValue, cls = '') => `<tr${cls ? ` class="${cls}"` : ''}><td>${label}</td>`
    + `${showCodex ? `<td class="num">${codexValue}</td>` : ''}${showCursor ? `<td class="num">${cursorValue}</td>` : ''}</tr>`;
  const days = st.daily.slice().reverse().map(d => row(
    dayLabel(d.date, now),
    st.ready ? tokens(d.total) : '…',
    beforeCycle(d.date) ? '-' : sp.ready ? usd(cents[d.date] ?? 0) : '…',
  ));
  const weekCents = sp.daily.reduce((s, d) => s + d.cents, 0);
  const total = row('7 天', st.ready ? tokens(st.week.total) : '…', sp.ready ? usd(weekCents) : '…', 'total');
  const cycle = showCursor && sp.ready ? row('本周期', '', usd(sp.totalCents), 'total') : '';
  const notes = [];
  if (showCodex && !st.ready) notes.push(`Codex 用量统计中 ${pct(st.progress * 100)}…`);
  if (showCodex && st.ready && st.week.total) {
    notes.push(`Codex 模型：${st.models.slice(0, 3).map(x => `${esc(x.model)} ${pct((x.total / st.week.total) * 100)}`).join('，')}`);
  }
  if (showCursor && sp.ready && sp.models.length) {
    notes.push(`Cursor 本周期模型：${sp.models.slice(0, 3).map(x => `${esc(x.model)} ${usd(x.cents)}`).join('，')}`);
  }
  if (showCursor && sp.error) notes.push(`Cursor 明细获取失败：${esc(sp.error)}`);
  return `<h2>用量</h2><table class="usage">${head}${days.join('')}${total}${cycle}</table>${lines(notes, 'meta')}`;
}

export function indexPage(snap, reminders) {
  return {
    title: 'Agent 监控',
    sections: [
      { name: 'alerts', html: alertsSection(reminders.unread, snap.now) },
      { name: 'quota', html: quotaSection(snap) },
      { name: 'active', html: activeSection(snap) },
      { name: 'recent', html: recentSection(snap) },
      { name: 'usage', html: usageSection(snap) },
    ],
  };
}

function detailHead(t, now, extra) {
  const meta = join([TOOL[t.tool], t.project && esc(t.project), ...extra]);
  return `<h1>${esc(t.title)}</h1><div class="t1">${statusTag(t.status)} ${meta}</div>`
    + `${t.cwd ? `<div class="meta">${esc(t.cwd)}</div>` : ''}<div class="meta">最近活动 ${when(t.updatedAt, now)}</div>`;
}

function messageBlock(msg, now, max) {
  if (!msg?.text) return '';
  const text = msg.text.length > max ? `${msg.text.slice(0, max - 1)}…` : msg.text;
  return `<div class="msg">${esc(text)}</div>${msg.at ? `<div class="meta">${when(msg.at, now)}</div>` : ''}`;
}

function codexDetail(d, now) {
  const t = d.task;
  const head = detailHead(t, now, [t.branch && esc(t.branch), esc(modelText(t))]);
  const state = [];
  if (t.status === 'running' || t.status === 'stalled') {
    state.push(join([t.runStartedAt && `${when(t.runStartedAt, now)} 开始，已运行 ${coarse(now - t.runStartedAt)}`, t.turnSteps && `${t.turnSteps} 步`, t.turnTokens && `${tokens(t.turnTokens)} tokens`]));
    if (t.status === 'stalled') state.push(`<b>${coarse(now - (t.updatedAt ?? now))}没有新进展</b>`);
    if (t.activity) state.push(esc(t.activity));
  } else if (t.lastRun) {
    state.push(join([`上一轮 ${when(t.lastRun.endedAt, now)} 结束`, t.lastRun.durationMs && `用时 ${duration(t.lastRun.durationMs)}`, t.lastRun.steps && `${t.lastRun.steps} 步`, t.lastRun.tokens && `${tokens(t.lastRun.tokens)} tokens`]));
  }
  if (t.status === 'aborted' && t.abortReason) state.push(`中断原因：${esc(ABORT[t.abortReason] ?? t.abortReason)}`);
  if (t.error) state.push(`错误：${esc(t.error)}`);
  const g = t.goal;
  const goal = g ? `<div class="msg">${esc(g.objective)}</div><div class="meta">${join([
    GOAL[g.status] ?? esc(g.status),
    g.tokensUsed && `已用 ${tokens(g.tokensUsed)}${g.tokenBudget ? ` / ${tokens(g.tokenBudget)}` : ''} tokens`,
    g.seconds && `耗时 ${duration(g.seconds * 1000)}`,
  ])}</div>` : '';
  const ti = d.tokenInfo;
  const usage = join([
    t.turnTokens && `本轮 ${tokens(t.turnTokens)}`,
    ti?.total?.total_tokens && `累计 ${tokens(ti.total.total_tokens)}`,
    t.contextPercent != null && `上下文 ${pct(t.contextPercent)}（${tokens(ti?.last?.input_tokens)} / ${tokens(d.contextWindow)}）`,
  ]);
  const subs = d.subagents.length ? `<table class="rows">${d.subagents.map(s => `<tr><td class="st">${statusTag(s.status)}</td>`
    + `<td>${esc(s.name)}<div class="meta">${join([s.role && esc(s.role), s.model && esc(s.model), s.tokens && `${tokens(s.tokens)} tokens`, when(s.updatedAt, now)])}</div></td></tr>`).join('')}</table>` : '';
  const body = [
    lines(state, 't3'),
    block('计划', stepTable(d.plan?.steps)),
    block('目标', goal),
    block('最新回复', messageBlock(d.lastMessage, now, 1500)),
    block('最近提问', messageBlock(d.lastPrompt, now, 600)),
    block('最近动作', activityTable(d.activity, now)),
    block('Token', usage && `<div class="t3">${usage}</div>`),
    block('子代理', subs),
  ];
  return [{ name: 'head', html: head }, { name: 'body', html: body.join('') }];
}

function cursorDetail(d, now) {
  const t = d.task;
  const head = detailHead(t, now, [MODE[t.mode] ?? (t.mode && esc(t.mode)), t.location === 'cloud' && '云端', esc(modelText(t))]);
  const state = [];
  if (t.status === 'waiting') state.push(`<b>${esc(t.waitingReason ?? '等待你确认')}</b>`);
  if (t.runStartedAt && (t.status === 'running' || t.status === 'stalled')) state.push(`${when(t.runStartedAt, now)} 开始，已运行 ${coarse(now - t.runStartedAt)}`);
  if (t.status === 'stalled') state.push(`<b>${coarse(now - (t.updatedAt ?? now))}没有新进展</b>`);
  if (t.activity) state.push(esc(t.activity));
  const changes = t.lines.files || t.lines.added || t.lines.removed
    ? `<div class="t3">+${t.lines.added} / -${t.lines.removed} 行 · ${t.lines.files} 个文件</div>` : '';
  const context = d.contextTokens ? `<div class="t3">${tokens(d.contextTokens)}${d.contextLimit ? ` / ${tokens(d.contextLimit)}（${pct((d.contextTokens / d.contextLimit) * 100)}）` : ''}</div>` : '';
  const spent = d.events.reduce((s, e) => s + e.cents, 0);
  const events = d.events.length ? `<div class="t3">本周期这个对话共 ${usd(spent)}</div><table class="usage">${d.events.slice(0, 15).map(e => `<tr><td>${when(e.at, now)}</td>`
    + `<td>${esc(e.model)}</td><td class="num">${tokens(e.tokens)}</td><td class="num">${usd(e.cents)}</td></tr>`).join('')}</table>` : '';
  const messages = d.messages.map(m => `<div class="who">${join([m.role === 'user' ? '你' : 'AI', m.at && when(m.at, now)])}</div>`
    + `<div class="msg">${esc(m.text)}</div>`).join('');
  const body = [
    lines(state, 't3'),
    block('待办', stepTable(d.todos)),
    block('最近对话', messages),
    block('最近动作', activityTable(d.actions, now)),
    block('改动', changes),
    block('上下文', context),
    block('花费', events),
  ];
  return [{ name: 'head', html: head }, { name: 'body', html: body.join('') }];
}

export function taskPage(tool, detail, now) {
  if (!detail) {
    return {
      title: '任务不存在',
      sections: [{ name: 'body', html: '<h1>找不到这个任务</h1><div class="t3">可能已归档，或不在最近的任务列表里。</div><div class="t3"><a href="/">返回首页</a></div>' }],
    };
  }
  return { title: detail.task.title, sections: tool === 'codex' ? codexDetail(detail, now) : cursorDetail(detail, now) };
}

export function remindersPage(reminders, now) {
  const { unread, all } = reminders;
  const head = `<table><tr><td><h1>提醒记录</h1></td><td class="r">${unread.length ? ackForm('/reminders') : ''}</td></tr></table>`;
  const list = all.length ? `<table class="rows">${all.map(r => reminderRow(r, now)).join('')}</table>` : '<div class="empty">还没有提醒</div>';
  return { title: '提醒记录', sections: [{ name: 'list', html: head + list }] };
}

function footer(refresh, choices) {
  const options = choices.map(sec => (sec === refresh ? `<b>${refreshLabel(sec)}</b>` : `<a href="?refresh=${sec}">${refreshLabel(sec)}</a>`));
  return `刷新间隔：${options.join(' ')}<br><a href="/">首页</a> · <a href="/reminders">提醒记录</a>`
    + '<span id="notify-wrap" style="display:none"> · <a id="notify" href="#">开启桌面通知</a></span>';
}

export function documentTitle(title, unreadCount) {
  return unreadCount ? `(${unreadCount}) ${title}` : title;
}

export function layout({ title, sections, refresh, choices, now, unread, assetVersion }) {
  const secs = sections.map(s => `<div class="sec" id="s-${s.name}" data-sec="${s.name}" data-h="${s.hash}">${s.html}</div>`).join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(documentTitle(title, unread.length))}</title>
<link rel="stylesheet" href="/static/style.css?v=${assetVersion}">
<noscript><meta http-equiv="refresh" content="${refresh}"></noscript>
</head>
<body data-refresh="${refresh}" data-seen="${esc(unread.slice(0, 5).map(r => r.id).join('|'))}">
<div id="wrap">
<table class="head"><tr><td class="brand"><a href="/">Agent 监控</a></td><td class="r"><span id="net">${clock(now)} 更新</span></td></tr></table>
${secs}
<div class="foot">${footer(refresh, choices)}</div>
</div>
<script src="/static/app.js?v=${assetVersion}"></script>
</body>
</html>`;
}

export function loginPage(wrongKey) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent 监控</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<div id="wrap">
<table class="head"><tr><td class="brand">Agent 监控</td></tr></table>
<p>${wrongKey ? '<b>访问密钥不正确。</b>' : ''}请输入访问密钥（启动服务时终端里打印的那串字符）。</p>
<form method="get" action="/"><input type="text" name="key" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"> <button type="submit">进入</button></form>
</div>
</body>
</html>`;
}
