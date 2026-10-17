import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const quoteHandler = read("../netlify/functions/quote.mjs");
const migration = read("../supabase/proposed/017_fast_delivery.sql");
const paymentHandler = read("../netlify/functions/create-paystack-payment.mjs");
const riderLocationHandler = read("../netlify/functions/rider-location.mjs");
const customerAndRiderUi = read("../../frontend/src/App.jsx");

test("fast quote pricing doubles the current standard quote", async () => {
  const {calculatePriceForDeliverySpeed, calculateSuggestedPrice} =
    await import("../netlify/functions/_package-selection.mjs");
  const standard = calculateSuggestedPrice(10000, "medium");
  assert.equal(standard, 2250);
  assert.equal(calculatePriceForDeliverySpeed(standard, "standard"), standard);
  assert.equal(calculatePriceForDeliverySpeed(standard, "fast"), standard * 2);
  assert.match(quoteHandler, /deliverySpeed=request\.deliverySpeed===undefined\?"standard":request\.deliverySpeed/);
  assert.match(quoteHandler, /deliverySpeed==="fast".*!.*small.*medium/);
});

test("fast delivery remains limited to small and medium categories with approval-gated payment", () => {
  assert.match(migration, /p_delivery_speed\s*=\s*'fast'.*p_package_category\s+not in \('small', 'medium'\)/s);
  assert.match(migration, /o\.payment_status\s*=\s*'paid'/);
  assert.match(migration, /pickup_deadline_at\s*=\s*accepted_at_value/);
  assert.match(migration, /delivery_service_rules/);
  assert.match(paymentHandler, /quote\.status\s*!==\s*"approved"/);
  assert.match(paymentHandler, /o\.payment_status\s*!==\s*"unpaid"/);
});

test("rider deadline and ETA are presented as estimates, not guaranteed completion", () => {
  assert.match(customerAndRiderUi, /PickupDeadline acceptedAt=\{active\.accepted_at\}/);
  assert.match(customerAndRiderUi, /etaStatus/);
  assert.match(customerAndRiderUi, /Pickup-arrival deadline passed/);
  assert.match(riderLocationHandler, /OpenRouteService route estimate/);
  assert.match(riderLocationHandler, /const target = customerRequest\s*\?\s*interstateOrigin\s*\?\s*\{latitude:interstateOrigin\.latitude,longitude:interstateOrigin\.longitude\}\s*:\s*\{ latitude: order\.dropoff_latitude, longitude: order\.dropoff_longitude \}\s*:\s*\{ latitude: order\.pickup_latitude, longitude: order\.pickup_longitude \}/);
});
