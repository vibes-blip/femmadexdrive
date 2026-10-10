export const activeOrderStatuses = new Set([
  "paid", "accepted", "picked_up", "on_the_way", "at_door", "delivered",
]);

export const terminalCallStates = new Set(["ended", "declined", "missed", "failed"]);

export function assertCallStartAuthorized(order, assignment, userId, requestedOrderId) {
  if (!order || order.id !== requestedOrderId || !order.rider_id || !activeOrderStatuses.has(order.status)) {
    throw new Error("Voice calls are available only for an assigned active delivery.");
  }
  if (userId !== order.customer_id && userId !== order.rider_id) {
    throw new Error("You are not a participant in this delivery.");
  }
  if (!assignment?.id || assignment.order_id !== order.id || assignment.rider_id !== order.rider_id || assignment.ended_at) {
    throw new Error("Voice calls are unavailable for this delivery assignment.");
  }
}

export function assertCallActionAuthorized({ action, call, order, assignment, userId, requestedOrderId, now = Date.now() }) {
  if (!call || call.order_id !== requestedOrderId) {
    throw new Error("Call not found for this delivery.");
  }
  if (userId !== call.caller_id && userId !== call.receiver_id) {
    throw new Error("You are not a participant in this call.");
  }
  if (!order || order.id !== call.order_id || (userId !== order.customer_id && userId !== order.rider_id)) {
    throw new Error("You are no longer a participant in this delivery.");
  }
  if (!assignment?.id || call.assignment_id !== assignment.id
      || assignment.order_id !== order.id || assignment.rider_id !== order.rider_id || assignment.ended_at) {
    throw new Error("This call is outside the current delivery assignment.");
  }
  if (terminalCallStates.has(call.status)) return;

  if (action === "answer") {
    if (userId !== call.receiver_id || call.status !== "ringing" || !activeOrderStatuses.has(order.status)) {
      throw new Error("This call cannot be answered by this user.");
    }
    return;
  }
  if (action === "decline") {
    if (userId !== call.receiver_id || call.status !== "ringing") {
      throw new Error("Only the recipient may decline a ringing call.");
    }
    return;
  }
  if (action === "timeout") {
    if (call.status !== "ringing" || now - new Date(call.started_at).getTime() < 45_000) {
      throw new Error("This call has not timed out.");
    }
    return;
  }
  if (action === "end" && ["ringing", "answered"].includes(call.status)) return;
  throw new Error("Invalid call state transition.");
}
