import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clientAddressFromRequest, publicTrackingView, trackingRateLimitKey } from "../netlify/functions/_public-tracking-security.mjs";
import { assertCallActionAuthorized, assertCallStartAuthorized } from "../netlify/functions/_call-security.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const trackingHandler = read("../netlify/functions/public-track.mjs");
const callHandler = read("../netlify/functions/livekit-call.mjs");
const securityMigration = read("../supabase/proposed/016_security_remediation.sql");
const packageTests = read("./package-selection.test.mjs");
const dispatchTests = read("./dispatch-contract.test.mjs");

test("public tracking projection allowlists only status-tracking fields", () => {
  const result = publicTrackingView({
    id: "internal-id",
    tracking_number: "FDD-1234ABCD",
    status: "on_the_way",
    pickup_address: "private pickup",
    dropoff_address: "private destination",
    pickup_latitude: 1.23,
    recipient_name: "Private recipient",
    recipient_phone: "private phone",
    payment_status: "paid",
    accepted_at: "2026-10-10T10:00:00Z",
    pickup_at: "2026-10-10T10:10:00Z",
  });

  assert.deepEqual(Object.keys(result).sort(), ["completed_steps", "status", "tracking_number"]);
  assert.deepEqual(result.completed_steps, ["accepted", "picked_up", "on_the_way"]);
  assert.doesNotMatch(JSON.stringify(result), /private|internal-id|paid/);
  assert.equal(publicTrackingView({ tracking_number: "FDD-1234ABCD", status: "paid" }).status, "processing");
  assert.match(trackingHandler, /\.select\("tracking_number,status,accepted_at,pickup_at,at_door_at,delivered_at,completed_at"\)/);
  assert.match(trackingHandler, /publicTrackingView\(order\)/);
  assert.doesNotMatch(trackingHandler, /pickup_address|dropoff_address|recipient_phone|latitude|payment_status/);
});

test("tracking number lookup alone exposes no private delivery details and is rate limited before lookup", () => {
  assert.match(trackingHandler, /consume_public_tracking_rate_limit/);
  assert.ok(trackingHandler.indexOf("consume_public_tracking_rate_limit") < trackingHandler.indexOf('.from("orders")'));
  assert.match(trackingHandler, /p_limit:\s*30/);
  assert.match(securityMigration, /create table if not exists public\.public_tracking_rate_limits/i);
  assert.match(securityMigration, /revoke all on function public\.consume_public_tracking_rate_limit/i);
  assert.match(securityMigration, /grant execute on function public\.consume_public_tracking_rate_limit.*service_role/i);
  assert.match(securityMigration, /prune_public_tracking_rate_limits/i);
  assert.doesNotMatch(securityMigration.slice(0, securityMigration.indexOf("create or replace function public.prune_public_tracking_rate_limits")), /delete from public\.public_tracking_rate_limits/i);
  assert.match(trackingHandler, /Tracking details are unavailable\. Check the number and try again/);
  assert.match(trackingHandler, /if \(!address \|\| !secret\) return unavailable\(\)/);
});

test("tracking IP keys use validated proxy addresses and a server-side HMAC", () => {
  const request = (headers) => new Request("https://example.test", { headers });
  assert.equal(clientAddressFromRequest(request({ "x-nf-client-connection-ip": "203.0.113.7" })), "203.0.113.7");
  assert.equal(clientAddressFromRequest(request({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" })), null);
  assert.equal(clientAddressFromRequest(
    request({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" }), { trustForwardedFor: true },
  ), "198.51.100.4");
  assert.equal(clientAddressFromRequest(
    request({ "x-forwarded-for": "not-an-ip" }), { trustForwardedFor: true },
  ), null);
  assert.equal(trackingRateLimitKey("203.0.113.7", "server-secret"), trackingRateLimitKey("203.0.113.7", "server-secret"));
  assert.notEqual(trackingRateLimitKey("203.0.113.7", "server-secret"), trackingRateLimitKey("203.0.113.8", "server-secret"));
});

test("voice call start requires a current delivery participant and matching delivery id", () => {
  const order = { id: "order-1", customer_id: "customer-1", rider_id: "rider-1", status: "accepted" };
  const assignment = { id: "assignment-1", order_id: "order-1", rider_id: "rider-1", ended_at: null };
  assert.doesNotThrow(() => assertCallStartAuthorized(order, assignment, "customer-1", "order-1"));
  assert.throws(() => assertCallStartAuthorized(order, assignment, "intruder", "order-1"), /not a participant/);
  assert.throws(() => assertCallStartAuthorized(order, assignment, "customer-1", "order-2"), /assigned active delivery/);
  assert.match(callHandler, /assertCallStartAuthorized\(order, assignment, user\.id, input\.orderId\)/);
});

test("reassigned riders and callers cannot act on another delivery's call", () => {
  const call = {
    order_id: "order-1",
    assignment_id: "assignment-1",
    caller_id: "rider-old",
    receiver_id: "customer-1",
    status: "ringing",
    started_at: new Date(Date.now() - 5_000).toISOString(),
  };
  const reassignedOrder = { id: "order-1", customer_id: "customer-1", rider_id: "rider-new", status: "accepted" };
  const reassignedAssignment = { id: "assignment-2", order_id: "order-1", rider_id: "rider-new", ended_at: null };
  assert.throws(() => assertCallActionAuthorized({
    action: "answer", call, order: reassignedOrder, assignment: reassignedAssignment, userId: "rider-old", requestedOrderId: "order-1",
  }), /no longer a participant/);
  assert.throws(() => assertCallActionAuthorized({
    action: "answer", call, order: reassignedOrder, assignment: reassignedAssignment, userId: "customer-1", requestedOrderId: "order-2",
  }), /Call not found/);
  assert.throws(() => assertCallActionAuthorized({
    action: "decline", call: { ...call, status: "answered" }, order: reassignedOrder, assignment: reassignedAssignment,
    userId: "customer-1", requestedOrderId: "order-1",
  }), /outside the current delivery assignment/);
  assert.throws(() => assertCallActionAuthorized({
    action: "decline", call: { ...call, assignment_id: "assignment-2", status: "answered" },
    order: reassignedOrder, assignment: reassignedAssignment,
    userId: "customer-1", requestedOrderId: "order-1",
  }), /decline a ringing call/);
});

test("call state writes use conditional updates and database privileges are restricted in the proposal", () => {
  assert.match(callHandler, /\.eq\("id", call\.id\)\.eq\("status", "ringing"\)/);
  assert.match(callHandler, /\.eq\("id", call\.id\)\.eq\("status", call\.status\)/);
  assert.match(securityMigration, /revoke insert, update, delete on public\.call_logs from public, anon, authenticated/i);
  assert.match(securityMigration, /revoke update \(status, answered_at, ended_at, duration_seconds\)[\s\S]*on public\.call_logs from public, anon, authenticated/i);
  assert.match(securityMigration, /create trigger call_logs_prevent_tampering/i);
  assert.match(securityMigration, /call identity fields are immutable/i);
  assert.match(securityMigration, /invalid call status transition/i);
  assert.match(securityMigration, /call_logs_select_participants/);
  assert.match(securityMigration, /membership\.ended_at is null[\s\S]*or public\.current_user_role\(\) in \('admin', 'supervisor'\)/i);
  assert.match(securityMigration, /current_user_role\(\) is distinct from 'admin'/i);
  assert.match(securityMigration, /p_limit is null or p_limit < 1 or p_limit > 200/i);
  assert.match(securityMigration, /delivery_staff_access_audit/);
});

test("chat message access is assignment scoped; staff chat reads require an audited grant", () => {
  assert.match(securityMigration, /create table if not exists public\.delivery_chat_assignments/i);
  assert.match(securityMigration, /assignment_id uuid references public\.delivery_chat_assignments/i);
  assert.match(securityMigration, /chat_messages_select_assignment/i);
  assert.match(securityMigration, /membership\.rider_id = \(select auth\.uid\(\)\)/i);
  assert.match(securityMigration, /get_delivery_chat_for_staff/i);
  assert.match(securityMigration, /chat_read/i);
  assert.match(securityMigration, /grant_delivery_chat_access/i);
  assert.match(securityMigration, /update public\.call_logs c[\s\S]*c\.assignment_id in[\s\S]*delivery_chat_assignments/i);
  assert.match(securityMigration, /chat_rooms_select_assignment_participants/i);
  assert.match(securityMigration, /revoke insert, update, delete on public\.chat_rooms from public, anon, authenticated/i);
  assert.match(securityMigration, /create or replace function public\.ensure_order_chat_room/i);
  assert.match(securityMigration, /on conflict \(order_id, assignment_id\)/i);
  assert.match(securityMigration, /h\.action in \('assigned', 'reassigned', 'returned_to_pool', 'cancelled'\)/i);
  assert.doesNotMatch(securityMigration, /create policy chat_messages_select_assignment[\s\S]{0,500}current_user_role\(\) in \('admin',\s*'supervisor'\)/i);
  assert.match(securityMigration, /if public\.current_user_role\(\) is distinct from 'admin'/i);
  assert.match(securityMigration, /delivery_staff_access_audit[\s\S]*chat_access_granted[\s\S]*chat_read/i);
});

test("the current role model is fail-closed for a support role and old package/dispatch safeguards remain covered", () => {
  const roles = read("../supabase/migrations/001_femmadexdrive_v2.sql");
  assert.match(roles, /create type public\.user_role as enum \('customer','rider','supervisor','admin'\)/);
  assert.doesNotMatch(roles, /'support'/);
  assert.match(securityMigration, /does not add one/i);
  assert.match(packageTests, /package|price|payment/i);
  assert.match(dispatchTests, /redact private locations/);
  assert.match(dispatchTests, /approved unpaid quote/);
});
