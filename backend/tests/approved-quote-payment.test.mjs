import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const read=path=>readFileSync(new URL(path,import.meta.url),"utf8");
const migration=read("../supabase/migrations/028_prepare_approved_quote_payment.sql");
const completionMigration=read("../supabase/migrations/031_approved_quote_payment_completion.sql");
const paymentHandler=read("../netlify/functions/create-paystack-payment.mjs");
const adminUi=read("../../frontend/src/App.jsx");

test("only a matching, approved, unexpired, unpaid quote can normalize awaiting-payment status",()=>{
 assert.match(migration,/order_row\.customer_id <> p_customer_id/);
 assert.match(migration,/order_row\.payment_status <> 'unpaid'/);
 assert.match(migration,/order_row\.status not in \('approved', 'awaiting_payment'\)/);
 assert.match(migration,/quote_row\.status <> 'approved'/);
 assert.match(migration,/quote_row\.approved_price <> order_row\.final_price/);
 assert.match(migration,/quote_row\.expires_at <= now\(\)/);
 assert.match(migration,/set status = 'approved'/);
 assert.match(migration,/grant execute on function public\.prepare_approved_delivery_quote_payment\(uuid, uuid\)\s+to service_role/);
});

test("payment initialization reconciles approved legacy quotes before reserving payment",()=>{
 assert.match(paymentHandler,/prepare_approved_delivery_quote_payment/);
 assert.match(paymentHandler,/quote\.status==="approved"&&\["approved","awaiting_payment"\]\.includes\(orderStatus\)/);
 assert.match(paymentHandler,/reserve_customer_delivery_payment/);
 assert.match(paymentHandler,/Operations must approve it before payment/);
 assert.match(paymentHandler,/quoteStatus:quote\.status/);
});

test("Paystack completion accepts approved quotes and records their successful payment",()=>{
 assert.match(completionMigration,/order_row\.status not in \('awaiting_payment', 'approved'\)/);
 assert.match(completionMigration,/status in \('awaiting_payment', 'approved'\)[\s\S]*payment_status = 'unpaid'/);
 assert.match(completionMigration,/update public\.payments[\s\S]*set status = 'paid'[\s\S]*paid_at = now\(\)/);
 assert.match(completionMigration,/payment_confirmed/);
});

test("admin dashboard distinguishes the reviewed quote price from the order's final price",()=>{
 assert.match(adminUi,/reviewDetails\?\.status==="approved"&&reviewDetails\.approved_price\?money\(reviewDetails\.approved_price\):"Not approved"/);
 assert.match(adminUi,/Quote review/);
 assert.match(adminUi,/from\("payments"\)\.select\("reference,status,amount,wallet_credit,currency,paystack_status,payment_method,fee,created_at,paid_at"\)/);
 assert.match(adminUi,/admin-payment-records/);
 assert.match(adminUi,/This delivery quote is no longer awaiting review/);
 assert.doesNotMatch(adminUi,/!reviewDetails&&\["price_review","awaiting_payment"\]/);
 assert.doesNotMatch(adminUi,/Save final price/);
});

test("customer delivery history is always visible as compact expandable records",()=>{
 assert.match(adminUi,/<div className=\{`grid \$\{dispatchType!==\"within-state\"\?/);
 assert.match(adminUi,/aria-expanded=\{isOpen\}/);
 assert.match(adminUi,/setSelected\(isOpen\?null:order\)/);
 assert.match(adminUi,/View details/);
 assert.doesNotMatch(adminUi,/<small>\{order\.pickup_address\} → \{order\.dropoff_address\}<\/small>/);
});
