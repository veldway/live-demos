/**
 * Lead Triage, Live — a Veldway internal-build demo on Cloudflare Workers.
 *
 * Flow per request: deterministic rules decide the verdict first; spam and
 * injection NEVER reach a model; everything else gets model-written prose via
 * Workers AI under a per-IP rate limit and a hard daily cap. Any limit, error
 * or quota problem degrades to the deterministic fallback — the demo never
 * hard-fails and never spends past the free allocation (Workers AI free-plan
 * usage fails closed with an error; we catch it).
 *
 * Privacy: pasted lead text is never stored or logged. KV holds only anonymous
 * counters (a daily total and a salted hash of the caller IP, 60 s TTL).
 */
import { triage, InputError } from "./rules.js";
import { buildPrompt, splitAnswer, fallbackProse } from "./prose.js";
import { HTML, CSS, APP_JS } from "./page.js";

const MODEL = "@cf/meta/llama-3.1-8b-instruct";
const LIMITS = { message: 1500, name: 80, company: 80 };
const SOURCES = new Set(["contact-form", "website", "referral", "partner", "other"]);
const PER_IP_PER_MINUTE = 4;
const MODEL_TIMEOUT_MS = 12_000;

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function respond(body, type, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": type, ...SECURITY_HEADERS, ...extra },
  });
}
const json = (obj, status = 200) =>
  respond(JSON.stringify(obj), "application/json; charset=utf-8", status, { "cache-control": "no-store" });

/** Validate and shape the demo input. Throws InputError with a user-safe message. */
export function shapeLead(body) {
  if (typeof body !== "object" || body === null) throw new InputError("Send a JSON object.");
  const message = String(body.message ?? "");
  if (!message.trim()) throw new InputError("The message is empty.");
  if (message.length > LIMITS.message) throw new InputError(`Message is over ${LIMITS.message} characters.`);
  const name = String(body.name ?? "").slice(0, LIMITS.name);
  const company = String(body.company ?? "").slice(0, LIMITS.company);
  const source = SOURCES.has(String(body.source)) ? String(body.source) : "other";
  return {
    id: "demo",
    received_at: new Date().toISOString(),
    source,
    name,
    email: "demo@example.com",
    company,
    message,
  };
}

/** Anonymous key for the caller: salted SHA-256 of the IP, first 16 hex chars. */
async function ipKey(ip, salt) {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Reserve one model call. Returns null when allowed, or a reason string when
 * the deterministic fallback must be used instead. Any KV failure => fallback
 * (fail closed: we would rather skip a model call than lose track of the cap).
 */
export async function reserveModelCall(env, ip, today) {
  const cap = Number(env.DAILY_CAP || 150);
  try {
    const dayKey = `day:${today}`;
    const used = Number((await env.RATE.get(dayKey)) || 0);
    if (used >= cap) return "daily live-model cap reached";
    const ipK = `ip:${await ipKey(ip || "unknown", env.IP_SALT || "veldway-demo")}`;
    const ipUsed = Number((await env.RATE.get(ipK)) || 0);
    if (ipUsed >= PER_IP_PER_MINUTE) return "per-visitor rate limit";
    await env.RATE.put(dayKey, String(used + 1), { expirationTtl: 60 * 60 * 48 });
    await env.RATE.put(ipK, String(ipUsed + 1), { expirationTtl: 60 });
    return null;
  } catch {
    return "rate counter unavailable";
  }
}

/** The core handler, pure enough to unit-test with a fake env. */
export async function triageRequest(body, env, ip, now = new Date()) {
  let lead;
  try {
    lead = shapeLead(body);
  } catch (err) {
    if (err instanceof InputError) return { status: 400, payload: { error: err.message } };
    throw err;
  }
  const verdict = triage(lead);

  if (verdict.category === "spam") {
    const fb = fallbackProse(lead, verdict);
    return {
      status: 200,
      payload: { verdict, ...fb, engine: "deterministic — spam and injection never reach a model" },
    };
  }

  const denied = await reserveModelCall(env, ip, now.toISOString().slice(0, 10));
  if (denied === null) {
    try {
      const prompt = buildPrompt(lead, verdict);
      let timer;
      const result = await Promise.race([
        env.AI.run(MODEL, { messages: [{ role: "user", content: prompt }], max_tokens: 400 }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("model timeout")), MODEL_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      const { summary, reply } = splitAnswer(result && result.response ? result.response : "");
      if (summary && reply) {
        return {
          status: 200,
          payload: { verdict, summary, reply, engine: `workers-ai ${MODEL} (live)` },
        };
      }
    } catch {
      // fall through to deterministic — never fail the demo on a model problem
    }
  }
  const fb = fallbackProse(lead, verdict);
  return {
    status: 200,
    payload: {
      verdict,
      ...fb,
      engine: `deterministic fallback${denied ? ` — ${denied}` : " — model unavailable"}`,
    },
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET") {
      if (url.pathname === "/") return respond(HTML, "text/html; charset=utf-8");
      if (url.pathname === "/style.css") return respond(CSS, "text/css; charset=utf-8");
      if (url.pathname === "/app.js") return respond(APP_JS, "text/javascript; charset=utf-8");
      return respond("Not found", "text/plain; charset=utf-8", 404);
    }
    if (request.method === "POST" && url.pathname === "/api/triage") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Send JSON." }, 400);
      }
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const { status, payload } = await triageRequest(body, env, ip);
      return json(payload, status);
    }
    return respond("Method not allowed", "text/plain; charset=utf-8", 405);
  },
};
