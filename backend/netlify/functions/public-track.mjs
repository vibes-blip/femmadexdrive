import { sb, json, body } from "./_lib.mjs";
import { clientAddressFromRequest, publicTrackingView, trackingRateLimitKey } from "./_public-tracking-security.mjs";

const genericNotFound = () => json({ error: "Tracking details are unavailable. Check the number and try again." }, 404);
const unavailable = () => json({ error: "Tracking is temporarily unavailable. Please try again shortly." }, 503);

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204 });

  const address = clientAddressFromRequest(req, {
    trustForwardedFor: process.env.TRUST_PROXY_CLIENT_IP === "true",
  });
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!address || !secret) return unavailable();

  let db;
  try {
    db = sb();
  } catch (error) {
    console.error("Public tracking could not initialize its database client", error);
    return unavailable();
  }
  let allowed;
  try {
    const key = trackingRateLimitKey(address, secret);
    const { data, error } = await db.rpc("consume_public_tracking_rate_limit", {
      p_key: key,
      p_limit: 30,
      p_window_seconds: 60,
    });
    if (error) throw error;
    allowed = data === true;
  } catch (error) {
    console.error("Public tracking rate-limit check failed", error);
    return unavailable();
  }
  if (!allowed) return json({ error: "Tracking is temporarily unavailable. Please try again shortly." }, 429);

  let input;
  try {
    input = await body(req);
  } catch {
    return genericNotFound();
  }
  const tracking = String(input?.tracking || "").trim().toUpperCase();
  if (!/^FDD-[A-F0-9]{8}$/.test(tracking)) return genericNotFound();

  try {
    const { data: order, error } = await db.from("orders")
      .select("tracking_number,status,accepted_at,pickup_at,at_door_at,delivered_at,completed_at")
      .eq("tracking_number", tracking)
      .maybeSingle();
    if (error || !order) return genericNotFound();
    return json({ order: publicTrackingView(order) });
  } catch (error) {
    console.error("Public tracking order lookup failed", error);
    return unavailable();
  }
};
