// Invariant suite for the sync simulation: these are the design's own claims,
// so each test is one sentence from the Reference Design made executable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSim, SKUS } from "../src/sim.js";

function drain(sim, maxTicks = 200) {
  for (let i = 0; i < maxTicks; i++) {
    sim.tick();
    const s = sim.snapshot();
    if (s.queueDepth === 0 && s.pending === 0) return s;
  }
  throw new Error("queue did not drain");
}

test("duplicate delivery with the same idempotency key applies once", () => {
  const sim = createSim(1);
  sim.customerOrder("TENT-2P");
  sim.duplicateLastWebhook();
  const s = drain(sim);
  assert.equal(s.stats.duplicatesIgnored, 1);
  assert.equal(s.stats.erpDocs, 1, "one ERP order document, not two");
  assert.equal(s.erp["TENT-2P"], 39);
  assert.equal(s.store["TENT-2P"], 39);
});

test("ERP outage: events age with backoff, nothing is lost, drain restores consistency", () => {
  const sim = createSim(2);
  sim.setErpDown(12);
  for (let i = 0; i < 5; i++) sim.customerOrder();
  let s = sim.snapshot();
  const accepted = s.stats.ordersAccepted;
  assert.equal(accepted, 5);
  // During the outage the queue holds everything.
  for (let i = 0; i < 6; i++) sim.tick();
  s = sim.snapshot();
  assert.equal(s.queueDepth, 5, "all five events still queued during the outage");
  assert.ok(s.oldestQueuedTicks >= 6, "queue age is visible");
  assert.equal(s.stats.processed, 0);
  s = drain(sim);
  assert.equal(s.stats.processed, 5, "every event applied after recovery");
  assert.equal(s.stats.erpDocs, 5);
  const totalErp = Object.values(s.erp).reduce((a, b) => a + b, 0);
  assert.equal(totalErp, 200 - 5, "ERP truth reflects all five orders exactly once");
  assert.deepEqual(s.store, s.erp, "store converged to ERP truth");
});

test("bulk delivery floods events but store updates respect the per-tick budget", () => {
  const sim = createSim(3);
  sim.bulkDelivery(200);
  const before = sim.snapshot().stats.storeUpdateCalls;
  sim.tick();
  const after = sim.snapshot().stats.storeUpdateCalls;
  assert.ok(after - before <= 2, `at most 2 store updates per tick (got ${after - before})`);
  const s = drain(sim);
  assert.deepEqual(s.store, s.erp, "store converges to the delivered quantities");
  assert.equal(s.erp["TENT-2P"], 80);
});

test("reconciliation finds injected drift, fixes it, and reports it", () => {
  const sim = createSim(4);
  drain(sim);
  const sku = sim.injectDrift();
  const findings = sim.reconcile();
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sku, sku);
  const s = sim.snapshot();
  assert.equal(s.store[sku], s.erp[sku], "drift fixed to ERP truth");
  assert.match(s.report[0], /drift on .* fixed/);
  // Steady state afterwards: a second sweep finds nothing.
  sim.reconcile();
  assert.match(sim.snapshot().report[0], /no drift found/);
});

test("reconciliation never judges a SKU with events still in flight", () => {
  const sim = createSim(5);
  sim.setErpDown(10);
  sim.customerOrder("LANTERN");
  sim.tick();
  const findings = sim.reconcile();
  assert.equal(findings.filter((f) => f.sku === "LANTERN").length, 0, "in-flight SKU skipped");
});

test("malformed events dead-letter visibly and the batch survives", () => {
  const sim = createSim(6);
  sim.injectMalformed();
  sim.customerOrder("STOVE-MINI");
  const s = drain(sim);
  assert.equal(s.dlq.length, 1);
  assert.match(s.dlq[0].reason, /refused at validation/);
  assert.equal(s.stats.processed, 1, "the healthy event still processed");
});

test("property: 600 mixed operations end with zero oversell and consistent systems", () => {
  for (const seed of [7, 11, 13]) {
    const sim = createSim(seed);
    for (let i = 0; i < 600; i++) {
      sim.tick({ autoOrder: true });
      if (i % 97 === 0) sim.bulkDelivery(50);
      if (i % 131 === 0) sim.duplicateLastWebhook();
      if (i % 173 === 0) sim.setErpDown(8);
      if (i % 211 === 0) sim.injectMalformed();
    }
    const s = drain(sim, 400);
    sim.reconcile();
    const done = sim.snapshot();
    assert.equal(done.stats.oversell, 0, `seed ${seed}: oversell stayed zero`);
    assert.deepEqual(done.store, done.erp, `seed ${seed}: store equals ERP after drain+reconcile`);
    assert.ok(done.stats.processed > 100, `seed ${seed}: the run actually did work (${done.stats.processed})`);
    assert.ok(done.stats.duplicatesIgnored >= 4, `seed ${seed}: duplicates were exercised`);
  }
});

test("determinism: same seed, same story", () => {
  const a = createSim(42);
  const b = createSim(42);
  for (let i = 0; i < 50; i++) {
    a.tick({ autoOrder: true });
    b.tick({ autoOrder: true });
  }
  assert.deepEqual(a.snapshot().erp, b.snapshot().erp);
  assert.deepEqual(a.snapshot().stats, b.snapshot().stats);
});

test("every SKU is covered by the initial state", () => {
  const s = createSim(1).snapshot();
  for (const sku of SKUS) {
    assert.equal(s.erp[sku], 40);
    assert.equal(s.store[sku], 40);
  }
});

test("the served copy of the engine is byte-identical to the tested source", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../src/sim.js"), "utf8");
  const served = readFileSync(join(here, "../assets/sim.js.txt"), "utf8");
  assert.equal(served, src, "run `npm run build:sync` after editing sim.js");
});

test("reconcile during an outage reports the skipped in-flight SKUs instead of a clean bill", () => {
  const sim = createSim(8);
  sim.setErpDown(20);
  sim.customerOrder("PACK-65L");
  sim.tick();
  sim.reconcile();
  const s = sim.snapshot();
  assert.ok(s.inFlight.includes("PACK-65L"), "snapshot exposes the in-flight SKU");
  assert.deepEqual(s.lastSkipped, s.inFlight);
  assert.ok(s.report.some((l) => /skipped — sync still in flight \(.*PACK-65L/.test(l)), s.report.join(" | "));
  assert.ok(!s.report.some((l) => /steady state/.test(l)), "must not claim steady state while skipping");
});

test("inFlight is empty once the queue drains", () => {
  const sim = createSim(9);
  sim.customerOrder("BOTTLE-1L");
  const s = drain(sim);
  assert.deepEqual(s.inFlight, []);
});

// The oversell claims are checked against a ledger kept OUTSIDE the engine: units a shopper
// was allowed to buy per SKU, against units that ever existed (40 + deliveries). The engine's
// own counter is asserted separately, so a bug in how it counts can't hide a real oversell.
function ledger() {
  const supply = Object.fromEntries(SKUS.map((s) => [s, 40]));
  const sold = Object.fromEntries(SKUS.map((s) => [s, 0]));
  // Checked at the moment each sale is accepted: a later delivery must not cover up a unit
  // that was sold before it existed.
  const violations = [];
  return {
    supply,
    sold,
    order(sim, sku) {
      const ev = sim.customerOrder(sku);
      if (ev) {
        sold[ev.sku] += 1;
        if (sold[ev.sku] > supply[ev.sku]) violations.push(`${ev.sku}: ${sold[ev.sku]} sold of ${supply[ev.sku]}`);
      }
      return ev;
    },
    deliver(sim, units) {
      sim.bulkDelivery(units);
      const per = Math.max(1, Math.round(units / SKUS.length));
      for (const s of SKUS) supply[s] += per;
    },
    oversold() {
      return violations;
    },
  };
}

test("orders still queued after an outage are not offered again (no oversell on recovery)", () => {
  // Bring one SKU down to 2 units, take the ERP down, sell both units at different ticks (so
  // they retry on different schedules), then keep buying whenever the store shows stock.
  const sim = createSim(1);
  const L = ledger();
  for (let i = 0; i < 38; i++) L.order(sim, "TENT-2P");
  drain(sim);
  sim.setErpDown(20);
  L.order(sim, "TENT-2P");
  for (let i = 0; i < 3; i++) sim.tick();
  L.order(sim, "TENT-2P");
  for (let i = 0; i < 60; i++) {
    sim.tick();
    if (sim.snapshot().store["TENT-2P"] > 0) L.order(sim, "TENT-2P");
  }
  const s = drain(sim);
  assert.deepEqual(L.oversold(), [], "the store re-offered units that were already sold");
  assert.equal(s.stats.oversell, 0);
  assert.equal(s.erp["TENT-2P"], 0);
  assert.equal(s.store["TENT-2P"], 0);
});

test("property: duplicates, malformed events and 30-tick outages never oversell (independent ledger)", () => {
  for (const seed of [3, 17, 29, 41, 53]) {
    const sim = createSim(seed);
    const L = ledger();
    let soldOutSeen = false;
    for (let i = 0; i < 700; i++) {
      if (i % 5 < 4) L.order(sim); // a busy shop: 4 orders every 5 ticks
      sim.tick();
      if (SKUS.some((k) => sim.snapshot().store[k] === 0)) soldOutSeen = true;
      if (i % 45 === 20) sim.setErpDown(30);
      if (i % 120 === 60) L.deliver(sim, 50);
      if (i % 37 === 0) sim.duplicateLastWebhook();
      if (i % 89 === 0) sim.injectMalformed();
    }
    const s = drain(sim, 400);
    sim.reconcile();
    const done = sim.snapshot();
    assert.deepEqual(L.oversold(), [], `seed ${seed}`);
    assert.equal(done.stats.oversell, 0, `seed ${seed}: engine counter`);
    assert.deepEqual(done.store, done.erp, `seed ${seed}: store equals ERP after drain+reconcile`);
    assert.ok(soldOutSeen, `seed ${seed}: stock actually ran out at least once`);
    assert.ok(s.dlq.length >= 1, `seed ${seed}: malformed events were exercised`);
  }
});

test("a corrupted count on a sold-out SKU oversells, the counter shows it, and the ERP records it", () => {
  const sim = createSim(10);
  const L = ledger();
  for (let i = 0; i < 40; i++) L.order(sim, "LANTERN");
  drain(sim);
  sim.injectDrift("LANTERN");
  assert.ok(L.order(sim, "LANTERN"), "the corrupted store count let a shopper buy");
  const s = drain(sim);
  assert.deepEqual(L.oversold(), ["LANTERN: 41 sold of 40"]);
  assert.equal(s.stats.oversell, 1, "the engine's counter agrees with the ledger");
  assert.equal(s.erp["LANTERN"], -1, "the ERP shows the oversold unit instead of clamping it away");
  assert.equal(s.store["LANTERN"], 0, "the store never shows negative stock");
  sim.reconcile();
  assert.ok(sim.snapshot().report.some((l) => /LANTERN.*oversold/.test(l)), sim.snapshot().report.join(" | "));
});

test("an oversell while orders are still queued is counted against available stock, not raw on-hand", () => {
  // LANTERN down to 1 unit; the ERP goes down; the last unit sells (its order waits in the
  // queue, so on-hand still reads 1); then a corrupted count lets one more shopper buy.
  const sim = createSim(12);
  const L = ledger();
  for (let i = 0; i < 39; i++) L.order(sim, "LANTERN");
  drain(sim);
  sim.setErpDown(15);
  L.order(sim, "LANTERN");
  sim.tick();
  assert.equal(sim.snapshot().erp["LANTERN"], 1, "on-hand hasn't absorbed the queued order yet");
  sim.injectDrift("LANTERN");
  assert.ok(L.order(sim, "LANTERN"));
  assert.deepEqual(L.oversold(), ["LANTERN: 41 sold of 40"]);
  assert.equal(sim.snapshot().stats.oversell, 1, "counted at the sale, though on-hand still read 1");
  const s = drain(sim);
  assert.equal(s.erp["LANTERN"], -1);
});

test("a malformed event is dead-lettered by validation and the healthy event behind it still applies in the same tick", () => {
  const sim = createSim(11);
  sim.injectMalformed();
  assert.equal(sim.snapshot().queueDepth, 1, "the malformed event arrives like any other: on the queue");
  assert.equal(sim.snapshot().dlq.length, 0);
  sim.customerOrder("STOVE-MINI");
  sim.tick();
  const s = sim.snapshot();
  assert.equal(s.dlq.length, 1);
  assert.match(s.dlq[0].reason, /refused at validation/);
  assert.equal(s.stats.processed, 1);
  assert.equal(s.erp["STOVE-MINI"], 39);
  assert.equal(s.queueDepth, 0, "nothing malformed is left retrying in the queue");
});
