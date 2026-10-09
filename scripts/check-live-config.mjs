import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const frontendEnv = resolve(root, "frontend/.env");
const backendEnv = resolve(root, "backend/.env");
const failures = [];

for (const envPath of [frontendEnv, backendEnv]) {
  if (!existsSync(envPath)) {
    console.error(`FAIL ${envPath.endsWith("frontend/.env") ? "frontend/.env" : "backend/.env"} exists`);
    failures.push("missing local env file");
    continue;
  }
  process.loadEnvFile(envPath);
}

async function check(label, operation) {
  try {
    await operation();
    console.log(`PASS ${label}`);
  } catch (error) {
    console.error(`FAIL ${label}: ${error.message}`);
    failures.push(label);
  }
}

async function request(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
}

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const apiBase = (process.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
const serverUrl = process.env.SUPABASE_URL;
const serverKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const appOrigin = process.env.APP_ORIGIN;

await check("frontend Supabase URL and public anon key configured", async () => {
  if (!supabaseUrl || !anonKey) throw new Error("set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY");
  if (new URL(supabaseUrl).protocol !== "https:") throw new Error("Supabase URL must use HTTPS");
});

await check("Render API base URL configured", async () => {
  if (!apiBase) throw new Error("set VITE_API_BASE_URL in frontend/.env and Netlify");
  if (new URL(apiBase).origin !== "https://femmadexdrive.onrender.com") throw new Error("API base URL is not the requested Render service");
});

if (supabaseUrl && anonKey) {
  await check("Supabase Auth API reachable", async () => {
    const response = await request(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/health`, {
      headers: { apikey: anonKey },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  });
}

await check("server Supabase URL and secret key configured", async () => {
  if (!serverUrl || !serverKey) throw new Error("set SUPABASE_URL and rotated SUPABASE_SECRET_KEY in backend/.env");
});

await check("frontend and server target the same Supabase project", async () => {
  if (!supabaseUrl || !serverUrl) throw new Error("both Supabase URLs must be configured");
  if (new URL(supabaseUrl).origin !== new URL(serverUrl).origin) throw new Error("frontend and backend project URLs differ");
});

if (serverUrl && serverKey) {
  for (const table of ["profiles", "riders", "orders", "payments", "order_events"]) {
    await check(`Supabase table ${table} is reachable`, async () => {
      const response = await request(`${serverUrl.replace(/\/$/, "")}/rest/v1/${table}?select=*&limit=0`, {
        headers: { apikey: serverKey, Authorization: `Bearer ${serverKey}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}; check the key and applied migrations`);
    });
  }
}

await check("APP_ORIGIN and Paystack callback route configured", async () => {
  if (!appOrigin || !apiBase) throw new Error("set APP_ORIGIN and VITE_API_BASE_URL");
  if (new URL(appOrigin).origin !== "https://femmadexdrive.netlify.app") throw new Error("APP_ORIGIN must match the requested Netlify site");
  if (new URL(apiBase).pathname.replace(/\/+$/, "") !== "/api") throw new Error("VITE_API_BASE_URL must point to the Render /api path");
  const server = await readFile(resolve(root, "backend/server.mjs"), "utf8");
  if (!server.includes('["paystack-callback"')) throw new Error("Render does not register the Paystack callback route");
});

if (appOrigin) {
  await check("deployed site is reachable", async () => {
    const response = await request(appOrigin);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  });

}

if (apiBase) {
  await check("Render API health endpoint is reachable", async () => {
    const response = await request(`${new URL(apiBase).origin}/health`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.ok !== true) throw new Error("unexpected health response");
  });

  await check("Render API allows the Netlify frontend origin", async () => {
    const response = await request(`${apiBase}/quote`, {
      method: "OPTIONS",
      headers: { Origin: appOrigin || "", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
    });
    if (response.status !== 204) throw new Error(`expected HTTP 204 preflight, received HTTP ${response.status}`);
    if (response.headers.get("access-control-allow-origin") !== new URL(appOrigin).origin) throw new Error("CORS allow-origin does not match APP_ORIGIN");
  });

  await check("Render Paystack webhook route is deployed and configured", async () => {
    const response = await request(`${apiBase}/paystack-webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (response.status !== 401 || !response.headers.get("content-type")?.includes("application/json")) {
      throw new Error(`expected JSON HTTP 401 for an unsigned webhook probe, received HTTP ${response.status}`);
    }
  });

  await check("Render LiveKit call endpoint is deployed", async () => {
    const response = await request(`${apiBase}/livekit-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start" }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status !== 400 || !String(data.error || "").toLowerCase().includes("authentication")) {
      throw new Error(`expected unauthenticated JSON HTTP 400, received HTTP ${response.status}`);
    }
  });
}

const paystackKey = process.env.PAYSTACK_SECRET_KEY;
await check("Paystack secret configured", async () => {
  if (!paystackKey) throw new Error("set a newly rotated test/live PAYSTACK_SECRET_KEY");
});
if (paystackKey) {
  await check("Paystack API key accepted (read-only verification probe)", async () => {
    const response = await request("https://api.paystack.co/transaction/verify/FDD-CONFIG-CHECK-NO-SUCH-REFERENCE", {
      headers: { Authorization: `Bearer ${paystackKey}` },
    });
    if (response.status === 401 || response.status === 403) throw new Error(`credential rejected (HTTP ${response.status})`);
  });
}

const orsKey = process.env.ORS_API_KEY;
await check("OpenRouteService key configured and accepted", async () => {
  if (!orsKey) throw new Error("set ORS_API_KEY");
  const response = await request("https://api.openrouteservice.org/geocode/search?text=Lagos&size=1", {
    headers: { Authorization: orsKey },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
});

const resendKey = process.env.RESEND_API_KEY;
await check("Resend key configured and accepted", async () => {
  if (!resendKey) throw new Error("set RESEND_API_KEY");
  const response = await request("https://api.resend.com/domains", {
    headers: { Authorization: `Bearer ${resendKey}` },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
});

await check("LiveKit server credentials configured", async () => {
  if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
    throw new Error("set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET in Render (or backend/.env locally)");
  }
  if (!process.env.LIVEKIT_URL.startsWith("wss://")) throw new Error("LIVEKIT_URL must use wss://");
});

await check("Render auto-completion scheduler is configured locally", async () => {
  const source = await readFile(resolve(root, "backend/server.mjs"), "utf8");
  if (!source.includes("auto_complete_deliveries") || !source.includes("setInterval(autoCompleteDeliveries, 60_000)")) {
    throw new Error("one-minute server-side completion schedule is missing");
  }
});

if (failures.length) {
  console.error(`\n${failures.length} check(s) need attention. No payment, email, or database writes were performed.`);
  process.exitCode = 1;
} else {
  console.log("\nAll read-only configuration and connectivity checks passed. Confirm scheduler activity in Render logs after deployment.");
}
