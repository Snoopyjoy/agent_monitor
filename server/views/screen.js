import { capitalize, clock, coarse, dayLabel, esc, join, monthDay, num, pct, pctAuto, PLAN, REMINDER, tokens, TOOL, usd, when } from './format.js';

const WEEKDAYS = '日一二三四五六';

const clampPct = v => Math.max(0, Math.min(100, Number(v) || 0)).toFixed(1);
const bar = (filled, cls = 'bar') => `<div class="${cls}"><div style="width:${clampPct(filled)}%"></div></div>`;
const big = text => `<div class="big${text.length > 7 ? ' long' : ''}">${text}</div>`;
const lines = list => list.filter(Boolean).map(l => `<div class="qs">${l}</div>`).join('');
const exhaustText = (projection, now) => (projection?.exhaustAt ? `<b>按当前速度 ${when(projection.exhaustAt, now)} 用完</b>` : '');

const STYLE = `
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; color: #000; }
body {
  width: 536px; height: 724px; overflow: hidden;
  font: 14px/1.35 "PingFang SC", "Helvetica Neue", Helvetica, sans-serif;
  font-variant-numeric: tabular-nums;
}
#page { height: 724px; padding: 10px 14px 8px; display: flex; flex-direction: column; }
.head { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 3px solid #000; padding-bottom: 4px; }
.brand, .now { font-size: 21px; font-weight: 700; }
.now small { font-size: 15px; font-weight: 400; margin-right: 6px; }
.quota { display: flex; border-bottom: 2px solid #000; padding: 8px 0 9px; }
.q { flex: 1; min-width: 0; overflow: hidden; }
.q + .q { border-left: 2px solid #000; margin-left: 12px; padding-left: 12px; }
.qh { font-size: 13px; font-weight: 700; letter-spacing: 1px; }
.qh span { font-weight: 400; letter-spacing: 0; }
.ql { font-size: 13px; margin-top: 4px; }
.big { font-size: 50px; font-weight: 700; line-height: 1.05; letter-spacing: -1px; white-space: nowrap; }
.big.long { font-size: 38px; line-height: 1.4; }
.bar { height: 14px; border: 2px solid #000; margin: 5px 0 6px; }
.bar div, .mini div { height: 100%; background: #000; }
.qs { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dim { color: #555; }
h2 { display: flex; justify-content: space-between; align-items: baseline; font-size: 16px; margin: 9px 0 0; padding-bottom: 3px; border-bottom: 2px solid #000; }
h2 small { font-size: 13px; font-weight: 400; }
.alerts { flex: 1; min-height: 0; display: flex; flex-direction: column; }
#rems { flex: 1; min-height: 0; overflow: hidden; }
.rem { display: flex; align-items: center; height: 31px; border-bottom: 1px solid #000; }
.tag { flex: none; width: 46px; text-align: center; font-size: 12px; line-height: 18px; border: 1px solid #000; margin-right: 8px; }
.tag.inv { background: #000; color: #fff; }
.rt { flex: 1; min-width: 0; font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rm { flex: none; font-size: 12px; margin-left: 8px; }
.empty { font-size: 14px; padding: 8px 0; }
table { width: 100%; border-collapse: collapse; }
td { height: 20px; padding: 0; font-size: 13px; white-space: nowrap; }
.th td { font-size: 12px; text-align: right; border-bottom: 1px solid #000; }
.d { width: 46px; }
.b { width: 30%; padding-left: 10px; }
.n { width: 20%; text-align: right; }
.mini { height: 10px; }
.total td { font-weight: 700; border-top: 1px solid #000; }
.foot { margin-top: 6px; padding-top: 4px; border-top: 2px solid #000; font-size: 12px; text-align: center; }
`;

// Rows that would only be partially visible are dropped once fonts have been laid out,
// and the rest are spread over the free space.
const TRIM = `var box = document.getElementById('rems');
if (box) {
  while (box.children.length > 1 && box.scrollHeight > box.clientHeight) box.removeChild(box.lastChild);
  var h = Math.min(42, Math.floor(box.clientHeight / box.children.length));
  for (var i = 0; i < box.children.length; i++) box.children[i].style.height = h + 'px';
}`;

function codexBlock(c, now) {
  const q = c.quota;
  const m = c.metric;
  const plan = q.planType ? PLAN[q.planType] ?? capitalize(q.planType) : '';
  const head = `<div class="qh">CODEX${plan ? ` <span>${esc(plan)}</span>` : ''}</div>`;
  if (!c.available) return `${head}${lines(['未检测到 Codex'])}`;
  if (!m) return `${head}${big('--')}${lines([esc(q.error ?? '暂无额度数据')])}`;
  const w = m.main;
  const cr = q.credits;
  return `${head}<div class="ql">${esc(w.label)}额度剩余</div>${big(pctAuto(w.remaining))}${bar(w.remaining)}${lines([
    q.limitReached && '<b>已触发限额</b>',
    w.resetAt && `${when(w.resetAt, now)} 重置 · ${coarse(w.resetAt - now)}后`,
    ...m.windows.filter(o => o !== w).map(o => join([`${esc(o.label)}剩余 ${pctAuto(o.remaining)}`, o.resetAt && `${coarse(o.resetAt - now)}后重置`])),
    exhaustText(w.projection, now),
    cr && !cr.unlimited && cr.balance != null && (cr.hasCredits || cr.balance > 0) && `Credits 余额 ${num(cr.balance)}`,
    q.source === 'log' && `<span class="dim">${when(q.at, now)} 的日志数据</span>`,
    q.error && `<span class="dim">${esc(q.error)}</span>`,
  ])}`;
}

function cursorBlock(c, now) {
  const q = c.quota;
  const m = c.metric;
  const head = `<div class="qh">CURSOR${q.membership ? ` <span>${esc(capitalize(q.membership))}</span>` : ''}</div>`;
  if (!c.available) return `${head}${lines(['未检测到 Cursor'])}`;
  if (q.unlimited) return `${head}<div class="ql">额度</div>${big('不限量')}`;
  if (!m) return `${head}${big('--')}${lines([esc(q.error ?? '暂无额度数据')])}`;
  const p = m.main;
  const top = p.limit
    ? `<div class="ql">${esc(p.label)}剩余</div>${big(usd(p.remaining))}${bar(100 - m.usedPercent)}`
    : `<div class="ql">${esc(p.label)}已用</div>${big(usd(p.used))}`;
  const sp = c.spend;
  return `${head}${top}${lines([
    p.limit && `已用 ${usd(p.used)} / ${usd(p.limit)} · ${pctAuto(m.usedPercent)}`,
    q.cycleEnd && `${monthDay(q.cycleEnd)} 重置 · ${coarse(q.cycleEnd - now)}后`,
    sp.ready && `今日 ${usd(sp.todayCents)}`,
    p.limit && (exhaustText(m.projection, now) || (m.projection && `周期末约用 ${pct(Math.min(100, m.projection.atEnd))}`)),
    q.error && `<span class="dim">${esc(q.error)}</span>`,
  ])}`;
}

function remindersBlock(items, unreadCount, now) {
  const head = `<h2>提醒<small>${unreadCount ? `未读 ${unreadCount}` : '没有未读'}</small></h2>`;
  if (!items.length) return `${head}<div class="empty">还没有提醒</div>`;
  const rows = items.slice(0, 15).map(r => `<div class="rem"><span class="tag${r.read ? '' : ' inv'}">${esc(REMINDER[r.kind] ?? r.kind)}</span>`
    + `<span class="rt">${esc(r.title)}</span><span class="rm">${join([TOOL[r.tool], when(r.at, now)])}</span></div>`);
  return `${head}<div id="rems">${rows.join('')}</div>`;
}

function usageBlock(snap) {
  const { codex, cursor, now } = snap;
  if (!codex.available && !cursor.available) return '';
  const st = codex.stats;
  const sp = cursor.spend;
  const cents = Object.fromEntries(sp.daily.map(d => [d.date, d.cents]));
  const cycleStart = cursor.quota.cycleStart;
  const beforeCycle = date => cycleStart && new Date(`${date}T23:59:59`).getTime() < cycleStart;
  const maxTokens = Math.max(1, ...st.daily.map(d => d.total));
  const maxCents = Math.max(1, ...sp.daily.map(d => d.cents));
  const codexCells = (fill, text) => (codex.available ? `<td class="b">${fill == null ? '' : bar(fill, 'mini')}</td><td class="n">${text}</td>` : '');
  const cursorCells = (fill, text) => (cursor.available ? `<td class="b">${fill == null ? '' : bar(fill, 'mini')}</td><td class="n">${text}</td>` : '');
  const days = st.daily.slice().reverse().map(d => {
    const c = cents[d.date] ?? 0;
    const skip = beforeCycle(d.date);
    return `<tr><td class="d">${dayLabel(d.date, now)}</td>`
      + codexCells(st.ready ? (d.total / maxTokens) * 100 : null, st.ready ? tokens(d.total) : '…')
      + cursorCells(sp.ready && !skip ? (c / maxCents) * 100 : null, skip ? '-' : sp.ready ? usd(c) : '…')
      + '</tr>';
  });
  const weekCents = sp.daily.reduce((s, d) => s + d.cents, 0);
  const head = `<tr class="th"><td></td>${codex.available ? '<td colspan="2">Codex tokens</td>' : ''}${cursor.available ? '<td colspan="2">Cursor 花费</td>' : ''}</tr>`;
  const total = `<tr class="total"><td>合计</td>${codexCells(null, st.ready ? tokens(st.week.total) : '…')}${cursorCells(null, sp.ready ? usd(weekCents) : '…')}</tr>`;
  const note = codex.available && !st.ready ? `Codex 统计中 ${pct(st.progress * 100)}` : '';
  return `<h2>近 7 天用量<small>${note}</small></h2><table>${head}${days.join('')}${total}</table>`;
}

/** A fixed 536×724 CSS-pixel page, captured at 2× to fill the Kindle Paperwhite's 1072×1448 screen. */
export function screenPage(snap, reminderItems, unreadCount) {
  const { now } = snap;
  const d = new Date(now);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Agent 看板</title>
<style>${STYLE}</style>
</head>
<body>
<div id="page">
<div class="head"><div class="brand">Agent 监控</div><div class="now"><small>${monthDay(now)} 周${WEEKDAYS[d.getDay()]}</small>${clock(now)}</div></div>
<div class="quota"><div class="q">${codexBlock(snap.codex, now)}</div><div class="q">${cursorBlock(snap.cursor, now)}</div></div>
<div class="alerts">${remindersBlock(reminderItems, unreadCount, now)}</div>
${usageBlock(snap)}
<div class="foot">按电源键退出看板 · 拔掉数据线也会退出</div>
</div>
<script>${TRIM}</script>
</body>
</html>`;
}
