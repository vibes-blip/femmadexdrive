import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sb } from "./netlify/functions/_lib.mjs";
import { refreshFastOfferRouteChecks } from "./netlify/functions/_fast-dispatch.mjs";
import { processSupportEscalations } from "./netlify/functions/_support-escalation.mjs";

const localEnv = fileURLToPath(new URL("./.env", import.meta.url));
if (existsSync(localEnv)) process.loadEnvFile(localEnv);

const port = Number(process.env.PORT || 10000);
const allowedOrigin = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).origin : "";
const routes = new Map([
  ["quote", { method: "POST", load: () => import("./netlify/functions/quote.mjs") }],
  ["create-order", { method: "POST", load: () => import("./netlify/functions/create-order.mjs") }],
  ["create-paystack-payment", { method: "POST", load: () => import("./netlify/functions/create-paystack-payment.mjs") }],
  ["notify", { method: "POST", load: () => import("./netlify/functions/notify.mjs") }],
  ["public-track", { method: "POST", load: () => import("./netlify/functions/public-track.mjs") }],
  ["reverse-geocode", { method: "GET", load: () => import("./netlify/functions/reverse-geocode.mjs") }],
  ["address-search", { method: "GET", load: () => import("./netlify/functions/address-search.mjs") }],
  ["paystack-callback", { method: "GET", load: () => import("./netlify/functions/paystack-callback.mjs") }],
  ["paystack-webhook", { method: "POST", load: () => import("./netlify/functions/paystack-webhook.mjs") }],
  ["livekit-call", { method: "POST", load: () => import("./netlify/functions/livekit-call.mjs") }],
  ["rider-location", { method: "POST", load: () => import("./netlify/functions/rider-location.mjs") }],
  ["rider-offers", { method: "POST", load: () => import("./netlify/functions/rider-offers.mjs") }],
  ["care-chat", { method: "POST", load: () => import("./netlify/functions/care-chat.mjs") }],
  ["care-speech", { method: "POST", load: () => import("./netlify/functions/care-speech.mjs") }],
  ["rider-wallet", { method: "POST", load: () => import("./netlify/functions/rider-wallet.mjs") }],
  ["admin-wallet", { method: "POST", load: () => import("./netlify/functions/admin-wallet.mjs") }],
]);

function corsHeaders(origin) {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-paystack-signature",
    "Vary": "Origin",
  });
  if (origin && allowedOrigin && origin === allowedOrigin) headers.set("Access-Control-Allow-Origin", allowedOrigin);
  return headers;
}

async function toWebRequest(incoming, url) {
  const chunks = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error("Request body is too large"), { status: 413 });
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  return new Request(url, {
    method: incoming.method,
    headers,
    ...(body.length ? { body } : {}),
  });
}

async function send(response, outgoing, origin) {
  const headers = new Headers(response.headers);
  for (const [name, value] of corsHeaders(origin)) headers.set(name, value);
  outgoing.writeHead(response.status, Object.fromEntries(headers.entries()));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

const server = createServer(async (incoming, outgoing) => {
  const url = new URL(incoming.url || "/", `http://${incoming.headers.host || "localhost"}`);
  const origin = incoming.headers.origin || "";

  if (url.pathname === "/" || url.pathname === "/api" || url.pathname === "/api/") {
    outgoing.writeHead(200, { "Content-Type": "application/json", ...Object.fromEntries(corsHeaders(origin).entries()) });
    outgoing.end(JSON.stringify({
      ok: true,
      service: "FemmaDexDrive API",
      routes: [
        "/health",
        "/api/health",
        "/api/quote",
        "/api/create-order",
        "/api/create-paystack-payment",
        "/api/notify",
        "/api/public-track",
        "/api/reverse-geocode",
        "/api/address-search",
        "/api/paystack-callback",
        "/api/paystack-webhook",
        "/api/livekit-call",
        "/api/rider-location",
        "/api/rider-offers",
        "/api/care-chat",
        "/api/care-speech",
        "/api/rider-wallet",
        "/api/admin-wallet",
      ],
    }));
    return;
  }

  if (url.pathname === "/health" || url.pathname === "/api/health") {
    outgoing.writeHead(200, { "Content-Type": "application/json", ...Object.fromEntries(corsHeaders(origin).entries()) });
    outgoing.end(JSON.stringify({ ok: true, status: "healthy" }));
    return;
  }

  if (!url.pathname.startsWith("/api/")) {
    outgoing.writeHead(404, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  if (incoming.method === "OPTIONS") {
    outgoing.writeHead(204, Object.fromEntries(corsHeaders(origin).entries()));
    outgoing.end();
    return;
  }

  const name = url.pathname.slice("/api/".length);
  const route = routes.get(name);
  if (!route) {
    outgoing.writeHead(404, { "Content-Type": "application/json", ...Object.fromEntries(corsHeaders(origin).entries()) });
    outgoing.end(JSON.stringify({ error: "API route not found" }));
    return;
  }

  if (incoming.method !== route.method) {
    outgoing.writeHead(405, { "Content-Type": "application/json", Allow: `${route.method}, OPTIONS`, ...Object.fromEntries(corsHeaders(origin).entries()) });
    outgoing.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    const handler = (await route.load()).default;
    const response = await handler(await toWebRequest(incoming, url));
    await send(response, outgoing, origin);
  } catch (error) {
    const status = error.status || 500;
    outgoing.writeHead(status, { "Content-Type": "application/json", ...Object.fromEntries(corsHeaders(origin).entries()) });
    outgoing.end(JSON.stringify({ error: status === 500 ? "Internal server error" : error.message }));
    if (status === 500) console.error("API request failed", error);
  }
});

async function autoCompleteDeliveries() {
  try {
    const { data, error } = await sb().rpc("auto_complete_deliveries");
    if (error) throw error;
    if (Number(data) > 0) console.log(`Automatically completed ${Number(data)} deliveries`);
  } catch (error) {
    console.error("Automatic delivery completion failed", error.message);
  }
}

let dispatchRefreshPromise;
async function refreshDispatchQueue() {
  if (dispatchRefreshPromise) return dispatchRefreshPromise;
  dispatchRefreshPromise = (async () => {
    const db = sb();
    const {error:dispatchError} = await db.rpc("dispatch_pending_orders");
    if (dispatchError) throw dispatchError;
    const checked = await refreshFastOfferRouteChecks(db);
    const {data:alerts,error:alertError} = await db.rpc("refresh_fast_delivery_alerts");
    if (alertError) throw alertError;
    if (checked > 0 || Number(alerts) > 0) {
      console.log(`Dispatch refresh checked ${checked} fast routes and recorded ${Number(alerts) || 0} pickup deadline alerts`);
    }
  })();
  try {
    await dispatchRefreshPromise;
  } catch (error) {
    console.error("Dispatch queue refresh failed", error.message);
  } finally {
    dispatchRefreshPromise = null;
  }
}

server.listen(port, "0.0.0.0", () => {
  console.log(`FemmaDexDrive API listening on port ${port}`);
  void autoCompleteDeliveries();
  void refreshDispatchQueue();
  void processSupportEscalations().catch(error => console.error("Support escalation processing failed", error.message));
  setInterval(autoCompleteDeliveries, 60_000);
  setInterval(refreshDispatchQueue, 30_000);
  setInterval(() => {
    void processSupportEscalations().catch(error => console.error("Support escalation processing failed", error.message));
  }, 15_000);
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
