import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "paper-pulp-fermentation.json");
const port = Number(process.env.PORT || 3039);
const seed = {
  "items": [
    {
      "code": "PF-001",
      "source": "构树皮",
      "vat": "三号缸",
      "baseDays": 4,
      "days": 5,
      "owner": "林素",
      "status": "发酵中",
      "initialStatus": "入缸",
      "observations": [
        {
          "date": "2026-06-15",
          "temperature": "24.6",
          "smell": "微酸",
          "fiber": "开始松散",
          "changedWater": "否",
          "abnormal": false,
          "updatedAt": "2026-06-15T08:00:00.000Z"
        }
      ],
      "statusEvents": [],
      "logs": [
        {
          "at": "2026-06-15",
          "step": "观察",
          "note": "温度24.6，气味微酸，纤维开始松散",
          "abnormal": false
        }
      ]
    }
  ]
};
const fields = [["code","批次编号","text"],["source","原料来源","text"],["vat","浸泡缸","text"],["days","发酵天数","number"],["owner","负责人","text"]];
const stages = ["入缸","发酵中","可抄纸","异常观察"];
const statLabels = ["入缸","发酵中","可抄纸","异常观察"];
const extraFields = [["temperature","温度"],["smell","气味状态"],["fiber","纤维松散度"],["changedWater","是否换水"],["abnormal","异味或霉点"]];
const obsTextFields = ["temperature","smell","fiber","changedWater","note"];
const readyDays = 7; // 发酵满 7 天可抄纸

function pad2(n) { return String(n).padStart(2, "0"); }
function todayKey() { const d = new Date(); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
function dateKey(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + "-" + pad2(m[2]) + "-" + pad2(m[3]);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}
function parseAbnormal(value) {
  const s = String(value ?? "").trim();
  if (!s) return false;
  if (/^(无|否|没|未|正常)/.test(s)) return false;
  return s.includes("是") || s.includes("有") || s.includes("霉") || s.includes("异");
}
function asAbnormal(value) { return typeof value === "boolean" ? value : parseAbnormal(value); }
function pickText(src, keys) {
  const out = {};
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") out[k] = String(v).trim();
  }
  return out;
}

// 每日观察按日期归档：同一天合并为一条，按日期排序后重放出天数与状态。
function normalizeItem(item) {
  item.logs ||= [];
  item.statusEvents ||= [];
  const byDate = new Map();
  for (const raw of item.observations || []) {
    const date = dateKey(raw.date || raw.at);
    if (!date) continue;
    const prev = byDate.get(date) || { date };
    byDate.set(date, {
      ...prev,
      ...pickText(raw, obsTextFields),
      date,
      abnormal: raw.abnormal === undefined ? Boolean(prev.abnormal) : asAbnormal(raw.abnormal),
      updatedAt: raw.updatedAt || raw.at || prev.updatedAt || null,
    });
  }
  item.observations = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!Number.isFinite(Number(item.baseDays))) item.baseDays = Math.max(0, Number(item.days || 0) - item.observations.length);
  item.baseDays = Number(item.baseDays);
  const { days, status } = deriveState(item);
  item.days = days;
  item.status = status;
  return item;
}

// 按时间顺序重放每日观察和人工状态调整，越靠后的记录越说了算；
// 补录较早日期只会增加天数，不会顶掉后来已经出现的可抄纸或异常状态。
function deriveState(item) {
  const events = [
    ...(item.observations || []).map(o => ({ date: o.date, at: o.updatedAt || o.date, kind: "obs", obs: o })),
    ...(item.statusEvents || []).map(e => ({ date: dateKey(e.at), at: e.at, kind: "status", status: e.status })),
  ].filter(e => e.date).sort((a, b) => (a.date === b.date ? String(a.at).localeCompare(String(b.at)) : a.date.localeCompare(b.date)));
  let days = Number(item.baseDays || 0);
  let status = item.initialStatus || item.status || stages[0];
  for (const e of events) {
    if (e.kind === "status") {
      if (stages.includes(e.status)) status = e.status;
      continue;
    }
    days += 1;
    status = e.obs.abnormal ? "异常观察" : days >= readyDays ? "可抄纸" : "发酵中";
  }
  return { days, status };
}

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const raw = await readFile(dbPath, "utf8");
  const db = JSON.parse(raw);
  db.items = (db.items || []).map(normalizeItem);
  if (JSON.stringify(db) !== JSON.stringify(JSON.parse(raw))) await saveDb(db);
  return db;
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId() { return "PF-" + Date.now(); }
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  let abnormalCount = 0;
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
    abnormalCount += (item.observations || []).filter(o => o.abnormal).length;
  }
  stats["异常记录"] = abnormalCount;
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount, observationCount: (item.observations || []).length };
}
function detailView(item) {
  const base = Number(item.baseDays || 0);
  const observations = (item.observations || []).map((o, i) => ({ ...o, day: base + i + 1 }));
  const logs = [...(item.logs || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { ...summarize(item), observations, logs };
}
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法纸浆发酵记录</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:14px 0 8px; font-size:15px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:110px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .actions { display:flex; gap:8px; } .actions button { flex:1; }
    table { width:100%; border-collapse:collapse; font-size:14px; } th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); } th { color:var(--muted); font-weight:400; }
    .modal { position:fixed; inset:0; background:rgba(32,36,31,.45); display:flex; justify-content:center; align-items:flex-start; padding:48px 16px; z-index:20; }
    .modal[hidden] { display:none; }
    .modal-panel { background:#fff; border-radius:8px; padding:18px; width:100%; max-width:780px; max-height:82vh; overflow:auto; }
    .modal-head { display:flex; justify-content:space-between; align-items:center; gap:12px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古法纸浆发酵记录</h1><div class="meta">纸浆批次、浸泡缸、换水和异常观察</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增纸浆批次</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存纸浆批次</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>每日观察记录</h2><label>选择纸浆批次</label><select name="id" id="itemSelect"></select><label>观察日期</label><input name="date" id="obsDate" type="date"><div id="extraFields"></div><p class="meta">同一天重复提交会更新当天记录；补录较早日期会按时间顺序重算天数与状态。</p><button>提交记录</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>每天记录温度、气味、纤维状态和换水情况，系统统计发酵进度与异常次数。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <div class="modal" id="detailModal" hidden>
    <div class="modal-panel">
      <div class="modal-head"><h2 id="detailTitle">批次详情</h2><button class="secondary" id="detailClose" type="button">关闭</button></div>
      <div id="detailBody"></div>
    </div>
  </div>
  <script>
    const fields = [["code","批次编号","text"],["source","原料来源","text"],["vat","浸泡缸","text"],["days","发酵天数","number"],["owner","负责人","text"]];
    const stages = ["入缸","发酵中","可抄纸","异常观察"];
    const extraFields = [["temperature","温度"],["smell","气味状态"],["fiber","纤维松散度"],["changedWater","是否换水"],["abnormal","异味或霉点"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const obsDate = document.querySelector('#obsDate');
    const detailModal = document.querySelector('#detailModal');
    const detailTitle = document.querySelector('#detailTitle');
    const detailBody = document.querySelector('#detailBody');
    let items = [];
    let stats = {};
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function todayLocal() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
      obsDate.value = todayLocal();
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.source || '')+'</option>').join('');
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
      document.querySelectorAll('[data-detail]').forEach(btn => btn.onclick = async () => { const item = await api('/api/items/'+btn.dataset.detail); showDetail(item); });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const obs = (item.observations || []).slice(-4).map(o => '<div'+(o.abnormal?' class="warn"':'')+'>'+o.date+' 温度'+(o.temperature || '—')+(o.abnormal?' · 有异常':'')+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+'<div class="meta">已记 '+(item.observationCount || 0)+' 天观察</div><label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><div class="actions"><button class="secondary" data-detail="'+(item.id || item.code)+'">详情</button><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button></div><div class="logs meta">'+(obs || '暂无记录')+'</div></article>';
    }
    function showDetail(item) {
      detailTitle.textContent = (item.code || item.id) + ' · ' + (item.source || '') + ' · ' + item.status;
      const rows = (item.observations || []).map(o => '<tr><td>'+o.date+'</td><td>第'+o.day+'天</td><td>'+(o.temperature || '—')+'</td><td>'+(o.smell || '—')+'</td><td>'+(o.fiber || '—')+'</td><td>'+(o.changedWater || '—')+'</td><td>'+(o.abnormal?'<span class="warn">有异常</span>':'正常')+'</td></tr>').join('');
      const logs = (item.logs || []).map(l => '<div>'+String(l.at || '').slice(0,10)+' · '+l.step+'：'+l.note+'</div>').join('');
      detailBody.innerHTML = '<h3>每日观察（按日期排列）</h3>'+(rows ? '<table><thead><tr><th>日期</th><th>天数</th><th>温度</th><th>气味</th><th>纤维</th><th>换水</th><th>异常</th></tr></thead><tbody>'+rows+'</tbody></table>' : '<p class="meta">暂无观察记录</p>')+'<h3>日志</h3><div class="logs meta" style="max-height:160px">'+(logs || '暂无日志')+'</div>';
      detailModal.hidden = false;
    }
    async function load() {
      const [itemsData, statsData] = await Promise.all([api('/api/items'), api('/api/stats')]);
      items = itemsData; stats = statsData;
      render();
    }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); obsDate.value = todayLocal(); await load(); };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    document.querySelector('#detailClose').onclick = () => { detailModal.hidden = true; };
    detailModal.onclick = event => { if (event.target === detailModal) detailModal.hidden = true; };
    renderForms(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const initialStatus = stages.includes(input.status) ? input.status : stages[0];
      const baseDays = Math.max(0, Number(input.days || 0) || 0);
      const item = {
        id: newId(),
        code: input.code,
        source: input.source,
        vat: input.vat,
        owner: input.owner,
        baseDays,
        days: baseDays,
        status: initialStatus,
        initialStatus,
        observations: [],
        statusEvents: [],
        logs: [{ at: new Date().toISOString(), step: "建档", note: "创建纸浆批次" }],
      };
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, summarize(item));
    }
    const detail = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (detail && req.method === "GET") {
      const item = db.items.find(x => x.id === detail[1] || x.code === detail[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      return send(res, 200, detailView(item));
    }
    if (detail && req.method === "PATCH") {
      const item = db.items.find(x => x.id === detail[1] || x.code === detail[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      for (const k of ["code", "source", "vat", "owner"]) if (input[k] !== undefined) item[k] = input[k];
      if (input.status !== undefined) {
        if (!stages.includes(input.status)) return send(res, 400, { error: "invalid_status" });
        item.statusEvents.push({ at: new Date().toISOString(), status: input.status });
        item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + input.status });
      }
      const { days, status } = deriveState(item);
      item.days = days;
      item.status = status;
      await saveDb(db);
      return send(res, 200, summarize(item));
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = db.items.find(x => x.id === log[1] || x.code === log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, summarize(item));
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = db.items.find(x => x.id === action[1] || x.code === action[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      let date = todayKey();
      if (input.date !== undefined && String(input.date).trim() !== "") {
        date = dateKey(input.date);
        if (!date) return send(res, 400, { error: "invalid_date" });
      }
      item.observations ||= [];
      // 同一天只保留一条：补记时合并更新当天的温度、异常等字段
      let obs = item.observations.find(o => o.date === date);
      const isNew = !obs;
      if (isNew) {
        obs = { date, abnormal: false };
        item.observations.push(obs);
      }
      Object.assign(obs, pickText(input, obsTextFields));
      if (input.abnormal !== undefined && String(input.abnormal).trim() !== "") obs.abnormal = parseAbnormal(input.abnormal);
      obs.updatedAt = new Date().toISOString();
      // 补录较早日期后按时间顺序重算天数与状态
      item.observations.sort((a, b) => a.date.localeCompare(b.date));
      const { days, status } = deriveState(item);
      item.days = days;
      item.status = status;
      const summary = "温度" + (obs.temperature || "—") + "，" + (obs.smell || "") + "，" + (obs.fiber || "") + (obs.abnormal ? "，有异常" : "");
      item.logs.push({ at: new Date().toISOString(), step: isNew ? "观察" : "补录", note: date + " " + summary, abnormal: obs.abnormal });
      await saveDb(db);
      return send(res, 201, summarize(item));
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古法纸浆发酵记录 listening on http://localhost:" + port));
