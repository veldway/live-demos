// Parity suite: the JS port must agree with the Python implementation on every
// fixture the Python code itself generated (test/parity-fixtures.json), plus
// the demo-side guards. Run: node --test triage/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { triage, budgetAmount, validate, InputError } from "../src/rules.js";
import { splitAnswer, fallbackProse, buildPrompt } from "../src/prose.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, "parity-fixtures.json"), "utf8"));

test("triage matches the Python implementation on every fixture case", () => {
  assert.ok(fixtures.cases.length >= 10, "fixture set loaded");
  for (const { lead, verdict } of fixtures.cases) {
    const got = triage(lead);
    assert.deepEqual(got, verdict, `lead ${lead.id}`);
  }
});

test("budgetAmount matches the Python implementation on every probe", () => {
  for (const [message, expected] of Object.entries(fixtures.budgets)) {
    assert.equal(budgetAmount(message), expected, JSON.stringify(message));
  }
});

test("hostile fixture is spam/0 with injection flagged and never gains score", () => {
  const hostile = fixtures.cases.find(({ verdict }) => verdict.injection_suspected);
  assert.ok(hostile, "a hostile fixture exists");
  const got = triage(hostile.lead);
  assert.equal(got.category, "spam");
  assert.equal(got.score, 0);
  assert.equal(got.injection_suspected, true);
});

test("validate refuses missing fields and empty messages", () => {
  assert.throws(() => validate({ id: "x" }), InputError);
  const lead = { ...fixtures.cases[0].lead, message: "   " };
  assert.throws(() => validate(lead), InputError);
});

test("splitAnswer parses the SUMMARY/REPLY form incl. wrapped lines", () => {
  const { summary, reply } = splitAnswer("SUMMARY: They need a sync fix.\nREPLY: Hi Priya,\nhappy to help.");
  assert.equal(summary, "They need a sync fix.");
  assert.equal(reply, "Hi Priya, happy to help.");
  // REPLY before SUMMARY: later SUMMARY still lands in summary, reply keeps its text.
  const r = splitAnswer("REPLY: Hello there.\nSUMMARY: A short note.");
  assert.equal(r.reply, "Hello there.");
  assert.equal(r.summary, "A short note.");
});

test("fallbackProse withholds the reply for spam and drafts one otherwise", () => {
  const spam = fixtures.cases.find(({ verdict }) => verdict.category === "spam");
  const fb = fallbackProse(spam.lead, spam.verdict);
  assert.match(fb.reply, /no reply drafted/);
  const ok = fixtures.cases.find(({ verdict }) => verdict.category === "hot");
  const fb2 = fallbackProse(ok.lead, ok.verdict);
  assert.match(fb2.reply, /thanks for getting in touch/);
  assert.ok(fb2.summary.includes(String(ok.verdict.score)));
});

test("buildPrompt pins the verdict and carries the lead fields", () => {
  const { lead, verdict } = fixtures.cases.find(({ verdict }) => verdict.category === "hot");
  const p = buildPrompt(lead, verdict);
  assert.ok(p.includes(`category ${verdict.category}, score ${verdict.score}`));
  assert.ok(p.includes("never change the given score"));
  assert.ok(p.includes(lead.message.slice(0, 20)));
});

test("splitAnswer handles REPLY: with the text starting on the next line (observed live)", () => {
  const observed = 'SUMMARY: T from C is inquiring about Klaviyo flows, no urgency.\n\nREPLY: \n"Hi T, thank you for reaching out. Can you share more details?"';
  const { summary, reply } = splitAnswer(observed);
  assert.match(summary, /^T from C is inquiring/);
  assert.ok(!summary.includes("thank you for reaching out"), "reply text must not leak into summary");
  assert.match(reply, /thank you for reaching out/);
});
