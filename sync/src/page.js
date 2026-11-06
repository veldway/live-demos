/** Static assets for the sync dashboard, served by the worker with a strict CSP. */

export const CSS = `
:root{--paper:#faf9f6;--card:#ffffff;--ink:#101a2b;--soft:#3f4a5f;--faint:#6b7585;--line:#e4e2dc;--accent:#1d4ed8;--ok:#116633;--warn:#8a5a00;--bad:#a4133c}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:26px 16px 60px}
p.eyebrow{font-family:ui-monospace,monospace;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin:0 0 8px}
h1{font-size:clamp(1.5rem,4vw,2.1rem);line-height:1.12;margin:0 0 8px}
.lede{color:var(--soft);max-width:640px;margin:0 0 18px}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}
.controls button{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:8px 13px;font-size:13.5px;cursor:pointer}
.controls button:hover{border-color:var(--ink)}
.controls button.primary{background:var(--ink);color:#fff;border-color:var(--ink)}
.controls button.danger{border-color:var(--bad);color:var(--bad)}
.controls button[disabled]{opacity:.45;cursor:wait}
.loading{font-size:12.5px;color:var(--faint);align-self:center}
.pill{display:inline-block;border-radius:999px;padding:3px 10px;font-family:ui-monospace,monospace;font-size:12px;font-weight:700}
.pill.up{background:#e7f0e9;color:var(--ok)} .pill.down{background:#fbe8ee;color:var(--bad)}
.counters{display:grid;gap:8px;grid-template-columns:repeat(2,1fr);margin:0 0 14px}
@media(min-width:700px){.counters{grid-template-columns:repeat(6,1fr)}}
.counter{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;min-width:0}
.counter b{display:block;font-size:20px;font-family:ui-monospace,monospace}
.counter span{font-size:11.5px;color:var(--faint);text-transform:uppercase;letter-spacing:.07em;overflow-wrap:anywhere}
.counter.ok b{color:var(--ok)} .counter.warn b{color:var(--warn)}
.grid{display:grid;gap:14px;grid-template-columns:1fr}
@media(min-width:830px){.grid{grid-template-columns:minmax(0,1fr) minmax(0,1.4fr)}}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;min-width:0}
h3{font-size:12px;font-family:ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin:0 0 8px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{font-family:ui-monospace,monospace;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);text-align:left;padding:4px 6px;border-bottom:1px solid var(--line)}
td{padding:5px 6px;border-bottom:1px dashed var(--line);vertical-align:top;overflow-wrap:break-word}
td.num{font-family:ui-monospace,monospace;text-align:right}
.sync-ok{color:var(--ok)} .sync-pending{color:var(--warn)} .sync-drift{color:var(--bad);font-weight:700}
.report{font-size:13.5px;color:var(--soft);white-space:pre-wrap;overflow-wrap:anywhere}
.honest{border-top:1px solid var(--line);margin-top:24px;padding-top:14px;font-size:13px;color:var(--soft)}
.honest a{color:var(--accent)}
footer{margin-top:14px;font-size:12px;color:var(--faint)}
`;

export const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Store–ERP Sync, Running — a Veldway demo</title>
<meta name="description" content="Veldway's Shopify–ERP inventory sync reference design, running as a live simulation: idempotency, rate-budget batching, outage queueing, and nightly reconciliation.">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div class="wrap">
<header>
  <p class="eyebrow">Veldway · reference design, running</p>
  <h1>“Our store and our warehouse disagree.”</h1>
  <p class="lede">This is our Shopify↔ERP sync design as a live simulation: the store and ERP are simulated, the algorithms are real. Break things with the buttons. Duplicate webhooks, ERP outages and malformed events never oversell; a corrupted store count can, until the nightly reconciliation finds it — which is why it runs.</p>
</header>

<div class="controls" aria-label="Simulation controls">
  <button id="toggle" disabled class="primary">Pause orders</button>
  <button id="dup" disabled>Deliver a duplicate webhook</button>
  <button id="bulk" disabled>Bulk delivery (+200 stock)</button>
  <button id="outage" disabled class="danger">ERP outage (30 ticks)</button>
  <button id="malformed" disabled>Inject malformed event</button>
  <button id="drift" disabled class="danger">Corrupt a store count</button>
  <button id="reconcile" disabled>Run nightly reconciliation</button>
  <button id="reset" disabled>Reset</button>
  <span class="pill up" id="erpStatus">ERP UP</span>
  <span class="loading" id="loading" role="status">Loading simulation…</span>
</div>

<div class="counters">
  <div class="counter ok"><b id="cOversell">0</b><span>oversold orders</span></div>
  <div class="counter"><b id="cProcessed">0</b><span>events applied</span></div>
  <div class="counter"><b id="cDupes">0</b><span>duplicates ignored</span></div>
  <div class="counter"><b id="cQueue">0</b><span>queue depth / age</span></div>
  <div class="counter"><b id="cCalls">0</b><span>store API calls</span></div>
  <div class="counter warn"><b id="cDlq">0</b><span>dead-lettered</span></div>
</div>

<div class="grid">
  <div class="card">
    <h3>Stock: ERP truth vs what the store shows</h3>
    <table aria-label="Stock comparison">
      <thead><tr><th>SKU</th><th>ERP</th><th>Store</th><th>State</th></tr></thead>
      <tbody id="stock"></tbody>
    </table>
    <h3 style="margin-top:14px">Last reconciliation</h3>
    <p class="report" id="report">not run yet — it's the nightly safety net, not the mechanism</p>
  </div>
  <div class="card">
    <h3>Event journey (receipt is not processing)</h3>
    <table aria-label="Event log">
      <thead><tr><th>Tick</th><th>Event</th><th>SKU</th><th>Status</th></tr></thead>
      <tbody id="log"></tbody>
    </table>
  </div>
</div>

<div class="honest">
  <strong>What this is:</strong> a Veldway reference design running as a deterministic simulation — the store and ERP are
  simulated; the idempotency, available-to-sell targets, batching, outage-queueing, validation and reconciliation logic is
  real and unit-tested (a property test checks every sale against an independent stock ledger, not against the engine's
  own counter, and the ERP is allowed to go below zero so an oversell can't be hidden). Not a client project.
  Design write-up: <a href="https://veldway.com/work/shopify-erp-inventory-sync" rel="noopener">veldway.com/work/shopify-erp-inventory-sync</a> ·
  Source: <a href="https://github.com/veldway/live-demos" rel="noopener">github.com/veldway/live-demos</a> ·
  <a href="https://veldway.com" rel="noopener">veldway.com</a>
</div>
<footer>Veldway · 3A, Ayub Chowk, Lahore 54000, Pakistan</footer>
</div>
<script type="module" src="/app.js"></script>
</body>
</html>`;

export const APP_JS = `
import { createSim, SKUS } from "/sim.js";

let sim = createSim(Date.now() % 100000);
let running = true;
const $ = (id) => document.getElementById(id);

function cell(text, cls) {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

function render() {
  const s = sim.snapshot();
  $("erpStatus").textContent = s.erpDown ? "ERP DOWN" : "ERP UP";
  $("erpStatus").className = "pill " + (s.erpDown ? "down" : "up");
  $("cOversell").textContent = s.stats.oversell;
  $("cProcessed").textContent = s.stats.processed;
  $("cDupes").textContent = s.stats.duplicatesIgnored;
  $("cQueue").textContent = s.queueDepth + (s.queueDepth ? " / " + s.oldestQueuedTicks + "t" : "");
  $("cCalls").textContent = s.stats.storeUpdateCalls;
  $("cDlq").textContent = s.dlq.length;

  const stock = $("stock");
  stock.textContent = "";
  for (const sku of SKUS) {
    const tr = document.createElement("tr");
    const erp = s.erp[sku], st = s.store[sku];
    let state, cls;
    if (erp < 0) { state = "OVERSOLD " + (-erp); cls = "sync-drift"; }
    else if (erp === st) { state = "in sync"; cls = "sync-ok"; }
    else if (s.inFlight.includes(sku)) { state = "syncing…"; cls = "sync-pending"; }
    else { state = "DRIFT"; cls = "sync-drift"; }
    tr.appendChild(cell(sku));
    tr.appendChild(cell(String(erp), "num"));
    tr.appendChild(cell(String(st), "num"));
    tr.appendChild(cell(state, cls));
    stock.appendChild(tr);
  }

  const log = $("log");
  log.textContent = "";
  for (const e of s.log.slice(0, 14)) {
    const tr = document.createElement("tr");
    tr.appendChild(cell(String(e.tick), "num"));
    tr.appendChild(cell(e.type));
    tr.appendChild(cell(e.sku));
    tr.appendChild(cell(e.status));
    log.appendChild(tr);
  }

  $("report").textContent = s.report.length ? s.report.join("\\n") : "not run yet — it's the nightly safety net, not the mechanism";
}

$("toggle").addEventListener("click", () => {
  running = !running;
  $("toggle").textContent = running ? "Pause orders" : "Resume orders";
});
$("dup").addEventListener("click", () => { sim.duplicateLastWebhook(); render(); });
$("bulk").addEventListener("click", () => { sim.bulkDelivery(200); render(); });
$("outage").addEventListener("click", () => { sim.setErpDown(30); render(); });
$("malformed").addEventListener("click", () => { sim.injectMalformed(); render(); });
$("drift").addEventListener("click", () => { sim.injectDrift(); render(); });
$("reconcile").addEventListener("click", () => { sim.reconcile(); render(); });
$("reset").addEventListener("click", () => { sim = createSim(Date.now() % 100000); render(); });

for (const b of document.querySelectorAll(".controls button")) b.disabled = false;
$("loading").textContent = "";
setInterval(() => { sim.tick({ autoOrder: running }); render(); }, 400);
render();
`;
