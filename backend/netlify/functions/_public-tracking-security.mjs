import { createHmac } from "node:crypto";
import { isIP } from "node:net";

const publicTrackingFields = ["tracking_number", "status", "completed_steps"];
const publicProgressStatuses = new Set([
  "accepted", "picked_up", "on_the_way", "at_door", "delivered", "completed", "cancelled",
]);

const publicInterstateEvents=new Set([
  "pickup_rider_assigned","collected_from_sender","arrived_origin_terminal",
  "transport_partner_received","in_transit","arrived_destination_station",
  "ready_for_collection","recipient_collected","interstate_delivery_completed",
]);

export function publicTrackingView(order,events=[]) {
  const completedSteps = [];
  if (order.accepted_at) completedSteps.push("accepted");
  if (order.pickup_at) completedSteps.push("picked_up");
  if (order.status === "on_the_way" || order.at_door_at || order.delivered_at || order.completed_at) {
    completedSteps.push("on_the_way");
  }
  if (order.at_door_at || order.delivered_at || order.completed_at) completedSteps.push("at_door");
  if (order.delivered_at || order.completed_at) completedSteps.push("delivered");
  if (order.completed_at) completedSteps.push("completed");

  const view=Object.fromEntries(publicTrackingFields.map((field) => [
    field,
    field === "completed_steps"
      ? completedSteps
      : field === "status" && !publicProgressStatuses.has(order.status)
        ? "processing"
        : order[field],
  ]));
  if(order.journey_type==="interstate"){
    if(order.status==="delivered")view.status="in_transit";
    view.completed_steps=[];
    view.journey_type="interstate";
    view.destination_station={
      name:order.destination_station_snapshot?.name||null,
      city:order.destination_station_snapshot?.city||null,
      state:order.destination_station_snapshot?.state||null,
    };
    view.estimated_delivery_min_days=order.estimated_delivery_min_days;
    view.estimated_delivery_max_days=order.estimated_delivery_max_days;
    view.milestones=(Array.isArray(events)?events:[])
      .filter(item=>publicInterstateEvents.has(item.event))
      .map(item=>({event:item.event,created_at:item.created_at}));
  }
  return view;
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
