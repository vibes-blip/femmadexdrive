import { createHmac } from "node:crypto";
import { isIP } from "node:net";

const publicTrackingFields = ["tracking_number", "status", "completed_steps"];
const publicProgressStatuses = new Set([
  "accepted", "picked_up", "on_the_way", "at_door", "delivered", "completed", "cancelled",
]);

export function publicTrackingView(order) {
  const completedSteps = [];
  if (order.accepted_at) completedSteps.push("accepted");
  if (order.pickup_at) completedSteps.push("picked_up");
  if (order.status === "on_the_way" || order.at_door_at || order.delivered_at || order.completed_at) {
    completedSteps.push("on_the_way");
  }
  if (order.at_door_at || order.delivered_at || order.completed_at) completedSteps.push("at_door");
  if (order.delivered_at || order.completed_at) completedSteps.push("delivered");
  if (order.completed_at) completedSteps.push("completed");

  return Object.fromEntries(publicTrackingFields.map((field) => [
    field,
    field === "completed_steps"
      ? completedSteps
      : field === "status" && !publicProgressStatuses.has(order.status)
        ? "processing"
        : order[field],
  ]));
}

export function clientAddressFromRequest(req, { trustForwardedFor = false } = {}) {
  const trustedHeaders = [
    "x-nf-client-connection-ip",
    "cf-connecting-ip",
  ];
  for (const name of trustedHeaders) {
    const candidate = req.headers.get(name)?.trim();
    if (candidate && isIP(candidate)) return candidate;
  }

  const forwarded = trustForwardedFor ? req.headers.get("x-forwarded-for") : null;
  if (forwarded) {
    const firstAddress = forwarded.split(",")[0].trim();
    if (isIP(firstAddress)) return firstAddress;
  }
  return null;
}

export function trackingRateLimitKey(clientAddress, secret) {
  if (!clientAddress || !secret) throw new Error("Tracking abuse protection is not configured.");
  return createHmac("sha256", secret).update(clientAddress).digest("hex");
}
