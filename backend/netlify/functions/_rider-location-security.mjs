const activeDeliveryStatuses = new Set(["accepted", "picked_up", "on_the_way", "at_door"]);

export function isCurrentCustomerDelivery(order, userId) {
  return Boolean(
    order &&
    typeof userId === "string" &&
    order.customer_id === userId &&
    typeof order.rider_id === "string" &&
    activeDeliveryStatuses.has(order.status)
  );
}

export function isCurrentAssignedRiderDelivery(order, userId) {
  return Boolean(
    order &&
    typeof userId === "string" &&
    order.rider_id === userId &&
    activeDeliveryStatuses.has(order.status)
  );
}
