import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const offerMigration = read("../supabase/migrations/015_package_categories_without_measurements.sql");
const dispatchMigration = read("../supabase/migrations/014_rider_offer_dispatch_and_admin_controls.sql");
const dispatchSqlContract = read("../supabase/tests/014_dispatch_contract.sql");
const privateLocationsMigration = read("../supabase/migrations/009_private_unassigned_delivery_locations.sql");
const packageUi = read("../../frontend/src/App.jsx");
const riderOffersUi = read("../../frontend/src/RiderDispatch.jsx");
const paymentHandler = read("../netlify/functions/create-paystack-payment.mjs");
const paymentMigration = read("../supabase/migrations/005_paystack_idempotency.sql");

test("unassigned rider offers redact private locations and recipient details", () => {
  const functionStart = offerMigration.indexOf("create function public.get_rider_available_orders()");
  const functionEnd = offerMigration.indexOf("revoke execute on function public.get_rider_available_orders()", functionStart);
  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);
  const functionSql = offerMigration.slice(functionStart, functionEnd);
  assert.match(functionSql, /null::text,\s*null::double precision,\s*null::double precision,\s*null::text,\s*null::double precision,\s*null::double precision,\s*null::text,\s*null::text,/);
  assert.match(functionSql, /offer\.rider_id\s*=\s*\(select auth\.uid\(\)\)/);
  assert.match(functionSql, /o\.rider_id\s+is\s+null/);
  assert.match(privateLocationsMigration, /rider_id=\(select auth\.uid\(\)\)/);
  assert.match(riderOffersUi, /Pickup and recipient details are available after you accept the delivery/);
});

test("the published package suggestions use supported dispatch vehicle categories", () => {
  const compatibilityStart = dispatchMigration.indexOf("create or replace function public.vehicle_compatible");
  const compatibilityEnd = dispatchMigration.indexOf("$$;", compatibilityStart);
  const compatibilitySql = dispatchMigration.slice(compatibilityStart, compatibilityEnd);
  assert.match(compatibilitySql, /'motorcycle',\s*'bike'/);
  assert.match(compatibilitySql, /'car'/);
  assert.match(compatibilitySql, /'van'/);
  assert.match(compatibilitySql, /'truck',\s*'lorry'/);
  assert.match(dispatchSqlContract, /vehicle_compatible\('lorry', 'truck'\)/);
  assert.match(packageUi, /Suggested vehicle: Motorcycle/);
  assert.match(packageUi, /Suggested vehicle: Motorcycle or car/);
  assert.match(packageUi, /Suggested vehicle: Car, van, truck or lorry/);
  assert.doesNotMatch(packageUi, /Suggested vehicle:[^"]*pickup/i);
  assert.match(packageUi, /oversized or uncertain loads may need inspection/i);
});

test("checkout requires the approved unpaid quote and sends its exact approved amount", () => {
  assert.match(paymentHandler, /quote\.status\s*!==\s*"approved"/);
  assert.match(paymentHandler, /o\.status\s*!==\s*"approved"/);
  assert.match(paymentHandler, /o\.payment_status\s*!==\s*"unpaid"/);
  assert.match(paymentHandler, /Number\(quote\.approved_price\)\s*!==\s*Number\(o\.final_price\)/);
  assert.match(paymentHandler, /amount:\s*Math\.round\(approvedPrice\s*\*\s*100\)/);
  assert.match(paymentMigration, /coalesce\(p_amount_minor,\s*-1\)\s*<>\s*round\(payment_row\.amount\s*\*\s*100\)::bigint/);
  assert.match(offerMigration, /vehicle_reviewed_at\s+is\s+not\s+null/);
});
