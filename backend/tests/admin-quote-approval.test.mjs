import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const read=path=>readFileSync(new URL(path,import.meta.url),"utf8");
const migration=read("../supabase/migrations/027_single_step_delivery_quote_approval.sql");
const app=read("../../frontend/src/App.jsx");

test("operations can approve a valid quote by setting its price in one step",()=>{
 const functionStart=migration.indexOf("create or replace function public.approve_delivery_quote");
 const functionEnd=migration.indexOf("$$;",functionStart);
 const approval=migration.slice(functionStart,functionEnd);
 assert.match(approval,/current_user_role\(\) not in \('admin', 'supervisor'\)/);
 assert.match(approval,/q\.status = 'pending_admin_review'/);
 assert.match(approval,/q\.expires_at > now\(\)/);
 assert.match(approval,/public\.set_order_price\(p_order_id, p_price\)/);
 assert.doesNotMatch(approval,/vehicle_reviewed_at/);
 assert.doesNotMatch(app,/vehicleReviewReason|verifyQuoteVehicle|Save verified vehicle/);
 assert.match(app,/Approve price and send to customer/);
});

test("an approved or awaiting-payment delivery exposes secure checkout to its customer",()=>{
 assert.match(app,/selected\.status==="approved"&&[\s\S]*?Continue to Payment/);
 assert.match(app,/selected\.status==="awaiting_payment"&&[\s\S]*?Pay \$\{money\(selected\.final_price\)\} securely/);
 assert.match(app,/api\("create-paystack-payment",\{orderId:order\.id\},token\)/);
});
