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
      "days": 5,
      "baseDays": 5,
      "owner": "林素",
      "status": "发酵中",
      "observations": [],
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
const stickyStatuses = ["可抄纸", "异常观察"];

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
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
function todayStr() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  return now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
}
function parseAbnormal(value) {
  const text = String(value || "");
  return text.includes("是") || text.includes("有");
}
// 每日观察按日期归档：同一天只保留一份，按日期升序排列
function normalizeObservations(item) {
  const byDate = new Map();
  for (const obs of item.observations || []) {
    const date = String(obs.date || obs.at || "").slice(0, 10) || todayStr();
    const abnormal = typeof obs.abnormal === "boolean" ? obs.abnormal : parseAbnormal(obs.abnormal);
    const clean = Object.fromEntries(Object.entries(obs).filter(([key, value]) => key !== "abnormal" && value !== "" && value != null));
    const prev = byDate.get(date);
    byDate.set(date, prev
      ? { ...prev, ...clean, date, abnormal: prev.abnormal || abnormal }
      : { ...clean, date, abnormal });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
// 按时间顺序重算发酵天数，并推出每一天对应的状态
function buildTimeline(item, observations) {
  const baseDays = Number(item.baseDays ?? Math.max(0, Number(item.days || 0) - observations.length));
  const timeline = observations.map((obs, index) => {
    const day = baseDays + index + 1;
    return { ...obs, day, dayStatus: obs.abnormal ? "异常观察" : day >= 7 ? "可抄纸" : "发酵中" };
  });
  return { baseDays, days: baseDays + timeline.length, timeline };
}
// 批次卡片、详情和统计共用的同一份归一化结果
function normalizeItem(item) {
  const observations = normalizeObservations(item);
  const { baseDays, days, timeline } = buildTimeline(item, observations);
  return { ...item, baseDays, days, observations, timeline };
}
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
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
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:120px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .actions { display:flex; gap:8px; } .actions button { flex:1; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古法纸浆发酵记录</h1><div class="meta">纸浆批次、浸泡缸、换水和异常观察</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增纸浆批次</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存纸浆批次</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>每日观察记录</h2><label>选择纸浆批次</label><select name="id" id="itemSelect"></select><label>观察日期</label><input name="date" type="date" required><div id="extraFields"></div><div class="meta" style="margin:8px 0">同一天重复提交会更新当天记录；补录较早日期会按时间顺序重算天数，已出现的可抄纸或异常状态不会被顶掉。</div><button>提交记录</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>每天记录温度、气味、纤维状态和换水情况，系统统计发酵进度与异常次数。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","批次编号","text"],["source","原料来源","text"],["vat","浸泡缸","text"],["days","发酵天数","number"],["owner","负责人","text"]];
    const stages = ["入缸","发酵中","可抄纸","异常观察"];
    const extraFields = [["temperature","温度"],["smell","气味状态"],["fiber","纤维松散度"],["changedWater","是否换水"],["abnormal","异味或霉点"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    let items = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function setDefaultDate() {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      actionForm.elements.date.value = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.name || item.shipType || item.source || item.plateSize || '')+'</option>').join('');
      // 统计与批次卡片使用同一份服务端归一化后的数据
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
      document.querySelectorAll('[data-detail]').forEach(btn => btn.onclick = () => { const panel = document.getElementById('detail-' + btn.dataset.detail); panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; });
    }
    function cardHtml(item) {
      const key = item.id || item.code;
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const tasks = (item.tasks || []).map(t => '<div class="meta">任务 '+t.position+' · '+t.status+' · '+t.tension+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      const timeline = (item.timeline || []).map(t => '<div>第'+t.day+'天 · '+t.date+' · 温度'+(t.temperature || '—')+' · '+(t.smell || '—')+' · '+(t.fiber || '—')+' · 换水：'+(t.changedWater || '—')+' · 异常：'+(t.abnormal ? '<span class="warn">有</span>' : '无')+' · '+t.dayStatus+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+tasks+'<label>状态</label><select data-status="'+key+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><div class="actions"><button class="secondary" data-note="'+key+'">追加备注</button><button class="secondary" data-detail="'+key+'">详情（'+(item.timeline || []).length+'天记录）</button></div><div class="logs meta" id="detail-'+key+'" style="display:none">'+(timeline || '暂无观察记录')+'</div><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); setDefaultDate(); await load(); };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); setDefaultDate(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(item => summarize(normalizeItem(item))));
    const getOne = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (getOne && req.method === "GET") {
      const item = db.items.find(x => x.id === getOne[1] || x.code === getOne[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      return send(res, 200, summarize(normalizeItem(item)));
    }
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const baseDays = Math.max(0, Number(input.days || 0));
      const item = { id: newId(), ...input, days: baseDays, baseDays, observations: [], logs: [{ at: new Date().toISOString(), step: "建档", note: "创建纸浆批次" }] };
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, normalizeItem(item));
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = db.items.find(x => x.id === patch[1] || x.code === patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      Object.assign(item, await body(req));
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
      await saveDb(db);
      return send(res, 200, normalizeItem(item));
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = db.items.find(x => x.id === log[1] || x.code === log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, normalizeItem(item));
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = db.items.find(x => x.id === action[1] || x.code === action[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.observations = normalizeObservations(item);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date || "")) ? String(input.date) : todayStr();
      const dates = item.observations.map(o => o.date);
      const latest = dates.length ? dates.slice().sort().at(-1) : null;
      const backfilled = latest !== null && date < latest; // 补录较早日期
      const existing = item.observations.find(o => o.date === date);
      const patchFields = {};
      for (const key of ["temperature", "smell", "fiber", "changedWater", "note"]) {
        const value = String(input[key] ?? "").trim();
        if (value) patchFields[key] = value;
      }
      const abnormalText = String(input.abnormal ?? "").trim();
      if (existing) {
        // 同一天再记：更新当天的温度和异常，留空的字段保持原值
        Object.assign(existing, patchFields);
        if (abnormalText) existing.abnormal = parseAbnormal(abnormalText);
        existing.updatedAt = new Date().toISOString();
      } else {
        item.observations.push({ date, ...patchFields, abnormal: abnormalText ? parseAbnormal(abnormalText) : false, at: new Date().toISOString() });
      }
      item.observations = normalizeObservations(item);
      const { baseDays, days, timeline } = buildTimeline(item, item.observations);
      item.baseDays = baseDays;
      item.days = days;
      if (timeline.length) {
        const computed = timeline[timeline.length - 1].dayStatus;
        // 后来已经出现的可抄纸或异常状态，不能被较早日期的补录顶掉
        if (!(backfilled && stickyStatuses.includes(item.status))) item.status = computed;
      }
      const entry = timeline.find(t => t.date === date);
      item.logs ||= [];
      item.logs.push({
        at: new Date().toISOString(),
        step: existing || backfilled ? "补录" : "观察",
        note: date + "（第" + entry.day + "天）温度" + (entry.temperature || "—") + "，" + (entry.smell || "—") + "，" + (entry.fiber || "—") + "，换水：" + (entry.changedWater || "—") + "，异常：" + (entry.abnormal ? "有" : "无")
      });
      await saveDb(db);
      return send(res, existing ? 200 : 201, normalizeItem(item));
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items.map(normalizeItem)));
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古法纸浆发酵记录 listening on http://localhost:" + port));
