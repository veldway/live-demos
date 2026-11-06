/**
 * Store↔ERP sync simulation — the shopify-erp-inventory-sync Reference Design,
 * running. Simulated store + ERP; REAL algorithms:
 *   - receipt is not processing: webhooks only land events on a queue
 *   - idempotency keys: at-least-once delivery never double-applies
 *   - per-SKU debounced, rate-budget batching toward the store
 *   - ERP outage = events age on the queue with backoff; nothing is dropped
 *   - malformed events fail validation and go to a dead-letter queue; the
 *     batch survives
 *   - nightly reconciliation compares full stock state, fixes drift, reports
 *
 * Direction of truth (as in the design): the ERP owns stock; the store owns
 * orders. The store decrements its own view at purchase (as Shopify does);
 * ERP-side changes flow to the store as absolute inventory targets. The target
 * is AVAILABLE-TO-SELL: the ERP's on-hand minus orders the ERP hasn't absorbed
 * yet. Pushing raw on-hand while orders are still queued (after an outage)
 * would re-offer units that are already sold.
 *
 * Pure and deterministic under a seed — the UI and the test suite drive the
 * same engine.
 */

export const SKUS = ["TENT-2P", "PACK-65L", "LANTERN", "STOVE-MINI", "BOTTLE-1L"];
const STORE_UPDATE_BUDGET_PER_TICK = 2; // simulated Admin-API rate budget
const MAX_BACKOFF_TICKS = 8;
const LOG_LIMIT = 60;

/** mulberry32 — tiny deterministic PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSim(seed = 42) {
  const rng = mulberry32(seed);
  const erp = new Map(SKUS.map((s) => [s, 40]));
  const store = new Map(SKUS.map((s) => [s, 40]));

  const state = {
    tick: 0,
    erpDownUntil: 0,
    queue: [], // {id, idKey, type, sku, qty, attempts, nextTick, receivedTick}
    dlq: [],
    processedKeys: new Set(),
    pendingTargets: new Map(), // sku -> true (flush reads ERP truth at flush time)
    log: [],
    report: [], // reconciliation findings
    nextEventId: 1,
    stats: {
      ordersAccepted: 0,
      ordersRejected: 0,
      oversell: 0,
      processed: 0,
      duplicatesIgnored: 0,
      storeUpdateCalls: 0,
      reconciliationsRun: 0,
      driftFound: 0,
      erpDocs: 0,
    },
  };

  const erpDown = () => state.tick < state.erpDownUntil;

  function logEvent(entry) {
    state.log.unshift({ tick: state.tick, ...entry });
    if (state.log.length > LOG_LIMIT) state.log.pop();
  }

  function enqueue(type, sku, qty, idKey) {
    const id = `E-${state.nextEventId++}`;
    const event = {
      id,
      idKey: idKey ?? `${type}:${id}`,
      type,
      sku,
      qty,
      attempts: 0,
      nextTick: state.tick,
      receivedTick: state.tick,
    };
    state.queue.push(event);
    logEvent({ id: event.id, type, sku, status: "queued" });
    return event;
  }

  /** A customer buys 1 unit of a (weighted-random or given) SKU — store side. */
  function customerOrder(sku) {
    const pick =
      sku ?? SKUS.filter((s) => (store.get(s) ?? 0) > 0)[Math.floor(rng() * SKUS.filter((s) => (store.get(s) ?? 0) > 0).length)] ?? SKUS[0];
    const shown = store.get(pick) ?? 0;
    if (shown <= 0) {
      state.stats.ordersRejected += 1;
      logEvent({ id: "-", type: "order_attempt", sku: pick, status: "rejected (shown sold out)" });
      return null;
    }
    const available = (erp.get(pick) ?? 0) - queuedOrderQty(pick);
    store.set(pick, shown - 1);
    state.stats.ordersAccepted += 1;
    if (available <= 0) {
      state.stats.oversell += 1;
      logEvent({ id: "-", type: "order_attempt", sku: pick, status: "OVERSOLD (nothing left to sell)" });
    }
    return enqueue("order_created", pick, 1);
  }

  /** ERP-side stock movement (delivery arriving, +qty per SKU spread). */
  function bulkDelivery(units = 200) {
    const per = Math.max(1, Math.round(units / SKUS.length));
    for (const sku of SKUS) {
      erp.set(sku, (erp.get(sku) ?? 0) + per);
      enqueue("stock_changed", sku, per);
    }
  }

  /** Re-deliver the most recent queued-or-processed event with the SAME idempotency key. */
  function duplicateLastWebhook() {
    const source = state.queue[state.queue.length - 1] ?? state.lastProcessed;
    if (!source) return null;
    const copy = enqueue(source.type, source.sku, source.qty, source.idKey);
    logEvent({ id: copy.id, type: copy.type, sku: copy.sku, status: "duplicate delivery (same key)" });
    return copy;
  }

  /** A webhook with no usable SKU or quantity: it arrives on the queue like any other. */
  function injectMalformed() {
    return enqueue("stock_changed", "?", Number.NaN);
  }

  function isValid(event) {
    return SKUS.includes(event.sku) && Number.isInteger(event.qty) && event.qty > 0;
  }

  function setErpDown(ticks = 30) {
    state.erpDownUntil = state.tick + ticks;
    logEvent({ id: "-", type: "erp", sku: "-", status: `ERP OUTAGE for ${ticks} ticks` });
  }

  /** Simulated future-developer mistake: the store view is silently corrupted. */
  function injectDrift(target) {
    const sku = SKUS.includes(target) ? target : SKUS[Math.floor(rng() * SKUS.length)];
    store.set(sku, (store.get(sku) ?? 0) + 7);
    logEvent({ id: "-", type: "drift", sku, status: "store count silently corrupted (+7)" });
    return sku;
  }

  /** Units of a SKU sold in the store whose orders the ERP hasn't applied yet (once per key). */
  function queuedOrderQty(sku) {
    const keys = new Set();
    let n = 0;
    for (const e of state.queue) {
      if (e.type !== "order_created" || e.sku !== sku) continue;
      if (state.processedKeys.has(e.idKey) || keys.has(e.idKey)) continue;
      keys.add(e.idKey);
      n += e.qty;
    }
    return n;
  }

  /** What the store may offer: ERP on-hand minus orders still on their way to the ERP. */
  function availableToSell(sku) {
    return Math.max(0, (erp.get(sku) ?? 0) - queuedOrderQty(sku));
  }

  /** SKUs whose sync is still in flight (queued events or a pending store update). */
  function inFlightSkus() {
    return SKUS.filter((sku) => state.pendingTargets.has(sku) || state.queue.some((e) => e.sku === sku));
  }

  /**
   * Nightly sweep: full stock compare; fixes drift and reports it. Only settled
   * SKUs can be judged — a SKU with events still in flight is skipped, and the
   * report says so (silence there would read as "checked and clean").
   */
  function reconcile() {
    state.stats.reconciliationsRun += 1;
    const findings = [];
    const skipped = inFlightSkus();
    const oversold = [];
    for (const sku of SKUS) {
      if (skipped.includes(sku)) continue;
      const truth = availableToSell(sku);
      const shown = store.get(sku) ?? 0;
      if (truth !== shown) {
        findings.push({ sku, erp: truth, store: shown });
        store.set(sku, truth);
        state.stats.driftFound += 1;
      }
      if ((erp.get(sku) ?? 0) < 0) oversold.push(sku);
    }
    const lines = findings.map((f) => `drift on ${f.sku}: store showed ${f.store}, ERP says ${f.erp} available — fixed`);
    for (const sku of oversold) {
      lines.push(`${sku} oversold by ${-erp.get(sku)} — the ERP is below zero; a person contacts those customers`);
    }
    if (skipped.length) {
      lines.push(`${skipped.length} SKU(s) skipped — sync still in flight (${skipped.join(", ")}); re-run after the queue drains`);
    }
    state.report = lines.length ? lines : ["no drift found — steady state"];
    state.lastSkipped = skipped;
    logEvent({ id: "-", type: "reconciliation", sku: "-", status: state.report[0] + (state.report.length > 1 ? ` (+${state.report.length - 1} more)` : "") });
    return findings;
  }

  function processQueue() {
    const remaining = [];
    for (const event of state.queue) {
      if (event.nextTick > state.tick) {
        remaining.push(event);
        continue;
      }
      if (!isValid(event)) {
        state.dlq.push({ id: event.id, reason: "missing or unknown sku / bad qty — refused at validation", tick: state.tick });
        logEvent({ id: event.id, type: event.type, sku: event.sku, status: "DEAD-LETTERED (malformed)" });
        continue;
      }
      if (state.processedKeys.has(event.idKey)) {
        state.stats.duplicatesIgnored += 1;
        logEvent({ id: event.id, type: event.type, sku: event.sku, status: "ignored (idempotency key seen)" });
        continue;
      }
      if (erpDown()) {
        event.attempts += 1;
        event.nextTick = state.tick + Math.min(MAX_BACKOFF_TICKS, 2 ** event.attempts);
        logEvent({ id: event.id, type: event.type, sku: event.sku, status: `retry in ${event.nextTick - state.tick} (ERP down, attempt ${event.attempts})` });
        remaining.push(event);
        continue;
      }
      if (event.type === "order_created") {
        // No clamp at zero: an ERP below zero is an oversell, and hiding it would hide the bug.
        erp.set(event.sku, (erp.get(event.sku) ?? 0) - event.qty);
        state.stats.erpDocs += 1;
      }
      // Both event types leave the store view to the batcher: it syncs to available-to-sell.
      state.pendingTargets.set(event.sku, true);
      state.processedKeys.add(event.idKey);
      state.stats.processed += 1;
      state.lastProcessed = event;
      logEvent({ id: event.id, type: event.type, sku: event.sku, status: "applied" });
    }
    state.queue = remaining;
  }

  /** Flush at most STORE_UPDATE_BUDGET_PER_TICK absolute inventory updates. */
  function flushBatcher() {
    let budget = STORE_UPDATE_BUDGET_PER_TICK;
    for (const sku of [...state.pendingTargets.keys()]) {
      if (budget === 0) break;
      state.pendingTargets.delete(sku);
      const target = availableToSell(sku);
      store.set(sku, target);
      state.stats.storeUpdateCalls += 1;
      budget -= 1;
      logEvent({ id: "-", type: "store_update", sku, status: `store set to available (${target})` });
    }
  }

  function tick({ autoOrder = false } = {}) {
    state.tick += 1;
    if (autoOrder && rng() < 0.6) customerOrder();
    processQueue();
    flushBatcher();
  }

  function snapshot() {
    return {
      tick: state.tick,
      erpDown: erpDown(),
      erp: Object.fromEntries(erp),
      store: Object.fromEntries(store),
      queueDepth: state.queue.length,
      oldestQueuedTicks: state.queue.length ? state.tick - Math.min(...state.queue.map((e) => e.receivedTick)) : 0,
      dlq: [...state.dlq],
      log: [...state.log],
      report: [...state.report],
      stats: { ...state.stats },
      pending: state.pendingTargets.size,
      inFlight: inFlightSkus(),
      lastSkipped: [...(state.lastSkipped ?? [])],
    };
  }

  return {
    tick,
    customerOrder,
    bulkDelivery,
    duplicateLastWebhook,
    injectMalformed,
    setErpDown,
    injectDrift,
    reconcile,
    snapshot,
  };
}
