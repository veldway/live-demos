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
