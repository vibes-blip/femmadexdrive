import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  compatibleVehicle,
  fastPickupRouteStatus,
} from "../netlify/functions/_fast-dispatch.mjs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read("../supabase/migrations/018_durable_dispatch_and_fast_eta.sql");
const riderOffers = read("../netlify/functions/rider-offers.mjs");
const riderUi = read("../../frontend/src/RiderDispatch.jsx");
const adminUi = read("../../frontend/src/AdminDispatchControls.jsx");
const server = read("../server.mjs");
const quoteMigration = read("../supabase/migrations/011_delivery_quote_review.sql");

test("fast route screening honors the configured pickup window and fails closed", () => {
  assert.equal(fastPickupRouteStatus(45, 120), "eligible");
  assert.equal(fastPickupRouteStatus(121, 120), "too_far");
  assert.equal(fastPickupRouteStatus(null, 120), "unavailable");
  assert.equal(fastPickupRouteStatus(10, null), "unavailable");
});

test("route eligibility uses the same explicit vehicle compatibility matrix", () => {
  assert.equal(compatibleVehicle("motorcycle", "bike"), true);
  assert.equal(compatibleVehicle("van", "car"), false);
  assert.equal(compatibleVehicle("truck", "lorry"), true);
});

test("paid dispatch offers persist without expiring; declines remain rider-specific", () => {
  assert.match(migration, /expires_at='infinity'::timestamptz/);
  assert.match(migration, /status in \('revoked','timed_out'\)/);
  assert.doesNotMatch(migration, /set status\s*=\s*'timed_out'[\s\S]{0,200}expires_at\s*<=/i);
  assert.match(migration, /previous\.status in \('declined','accepted'\)/);
  assert.match(migration, /o\.payment_status='paid'/);
  assert.match(migration, /o\.status in \('paid','searching'\)/);
  assert.match(quoteMigration, /expires_at <= now\(\)/);
});

test("fast orders require a fresh eligible server route check during atomic acceptance", () => {
  assert.match(migration, /fast_route_status<>'eligible'/);
  assert.match(migration, /fast_eta>max_pickup_minutes/);
  assert.match(migration, /fast_route_checked_at<accepted_at_value-interval '2 minutes'/);
  assert.match(migration, /update public\.orders o[\s\S]*and o\.rider_id is null[\s\S]*for update/i);
  assert.match(riderOffers, /refreshFastOfferRouteChecks\(db,\{riderId:user\.id\}\)/);
  assert.match(riderOffers, /route_check_status!=="eligible"/);
  assert.match(migration, /create or replace function public\.admin_assign_order/);
  assert.match(migration, /route_status<>'eligible'/);
  assert.match(adminUi, /routeOffer\?\.route_check_status==="eligible"/);
});

test("riders see elapsed request age without an expiring-offer countdown", () => {
  assert.match(riderUi, /Requested \{age\(offer\.offer_requested_at\|\|offer\.created_at,now\)\} ago/);
  assert.match(riderUi, /request remains available/);
  assert.doesNotMatch(riderUi, /Offer expires/);
});

test("overdue pickup deadlines notify operations without cancelling delivery", () => {
  assert.match(migration, /event='pickup_deadline_missed'/);
  assert.match(migration, /'pickup_deadline_missed',\s*'The fast-service pickup-arrival deadline passed/);
  assert.match(migration, /Delivery remains active/);
  assert.match(migration, /grant execute on function public\.refresh_fast_delivery_alerts\(\) to service_role/);
  assert.match(server, /rpc\("refresh_fast_delivery_alerts"\)/);
  assert.match(adminUi, /"pickup_deadline_missed"/);
});
