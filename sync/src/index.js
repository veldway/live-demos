/**
 * Store↔ERP Sync, Running — static-serving worker. No KV, no AI, no state:
 * the whole simulation runs in the visitor's browser, so the demo has zero
 * quota surface and zero cost. /sim.js serves the EXACT engine the unit tests
 * run (assets/sim.js.txt is a build-time copy of src/sim.js, pinned equal by
 * a test).
 */
import { HTML, CSS, APP_JS } from "./page.js";
import SIM_SOURCE from "../assets/sim.js.txt";

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function respond(body, type, status = 200) {
  return new Response(body, { status, headers: { "content-type": type, ...SECURITY_HEADERS } });
}

export default {
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return respond("Method not allowed", "text/plain; charset=utf-8", 405);
    }
    const { pathname } = new URL(request.url);
    if (pathname === "/") return respond(HTML, "text/html; charset=utf-8");
    if (pathname === "/style.css") return respond(CSS, "text/css; charset=utf-8");
    if (pathname === "/app.js") return respond(APP_JS, "text/javascript; charset=utf-8");
    if (pathname === "/sim.js") return respond(SIM_SOURCE, "text/javascript; charset=utf-8");
    return respond("Not found", "text/plain; charset=utf-8", 404);
  },
};
