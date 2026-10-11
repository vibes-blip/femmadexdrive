import test from "node:test";
import assert from "node:assert/strict";
import {
  isCurrentAssignedRiderDelivery,
  isCurrentCustomerDelivery,
} from "../netlify/functions/_rider-location-security.mjs";

const activeOrder = {
  customer_id: "customer-current",
  rider_id: "rider-current",
  status: "on_the_way",
};

test("only the customer and currently assigned rider can request active delivery location", () => {
  assert.equal(isCurrentCustomerDelivery(activeOrder, "customer-current"), true);
  assert.equal(isCurrentAssignedRiderDelivery(activeOrder, "rider-current"), true);
  assert.equal(isCurrentCustomerDelivery(activeOrder, "customer-other"), false);
  assert.equal(isCurrentAssignedRiderDelivery(activeOrder, "rider-other"), false);
});

test("previous riders lose location access as soon as an assignment changes", () => {
  const reassignedOrder = {...activeOrder, rider_id: "rider-new"};
  assert.equal(isCurrentAssignedRiderDelivery(reassignedOrder, "rider-current"), false);
  assert.equal(isCurrentAssignedRiderDelivery(reassignedOrder, "rider-new"), true);
});

test("unassigned and terminal deliveries do not expose rider location", () => {
  assert.equal(isCurrentAssignedRiderDelivery({...activeOrder, rider_id: null}, "rider-current"), false);
  assert.equal(isCurrentCustomerDelivery({...activeOrder, status: "completed"}, "customer-current"), false);
  assert.equal(isCurrentAssignedRiderDelivery({...activeOrder, status: "delivered"}, "rider-current"), false);
});
