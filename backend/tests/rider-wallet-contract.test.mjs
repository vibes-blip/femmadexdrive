import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const read=path=>readFileSync(new URL(path,import.meta.url),"utf8");
const migration=read("../supabase/migrations/023_rider_wallet_and_paystack_transfers.sql");
const customerRewards=read("../supabase/migrations/025_customer_delivery_rewards.sql");
const signup=read("../supabase/migrations/020_customer_care.sql");
const riderWallet=read("../netlify/functions/rider-wallet.mjs");
const adminWallet=read("../netlify/functions/admin-wallet.mjs");
const webhook=read("../netlify/functions/paystack-webhook.mjs");
const riderWalletUi=read("../../frontend/src/RiderWallet.jsx");

test("wallet initialization and delivery credits are idempotent and there is no signup bonus",()=>{
 assert.match(signup,/insert into public\.profiles[\s\S]*on conflict \(id\) do nothing/);
 assert.doesNotMatch(signup.slice(signup.indexOf("create or replace function public.handle_new_user"),signup.indexOf("create or replace function public.create_support_conversation")),/wallet|ledger/i);
 assert.match(migration,/create unique index if not exists rider_wallet_earning_order_uidx[\s\S]*on public\.rider_wallet_ledger\(source_order_id\)/);
 assert.match(migration,/create unique index if not exists rider_wallet_cashback_milestone_uidx[\s\S]*on public\.rider_wallet_ledger\(rider_id,milestone_number\)/);
 assert.match(migration,/reference text not null unique/);
 assert.match(customerRewards,/create unique index if not exists customer_wallet_source_entry_uidx[\s\S]*on public\.customer_wallet_ledger\(source_order_id,entry_type\)/);
 assert.match(customerRewards,/create unique index if not exists customer_wallet_cashback_once_uidx/);
 assert.match(customerRewards,/on conflict do nothing/);
});

test("wallet credits only completed, paid deliveries and serializes rider milestones",()=>{
 assert.match(migration,/new\.status<>'completed' or new\.payment_status<>'paid'/);
 assert.match(migration,/round\(new\.final_price\*0\.30,2\)/);
 assert.match(migration,/perform 1 from public\.profiles where id=new\.rider_id for update/);
 assert.match(migration,/on conflict do nothing\s+returning id into earning_id/);
 assert.match(migration,/completed_count%5=0/);
 assert.match(migration,/round\(batch_earnings\*0\.10,2\)/);
 assert.match(migration,/date_trunc\('month',now\(\)\)\+interval '1 month'/);
});

test("payout state transitions preserve Paystack terminal outcomes",()=>{
 assert.match(migration,/select status into current_status[\s\S]*?for update/);
 assert.match(migration,/current_status in \('success','failed','reversed'\)/);
 assert.match(migration,/current_status='success' and p_status='reversed'/);
 assert.match(migration,/current_status='processing' and p_status in \('pending','otp_required'\)/);
});

test("withdrawals require verified bank details and administrator OTP for pending transfers",()=>{
 assert.match(riderWallet,/reserve_rider_wallet_withdrawal/);
 assert.match(riderWallet,/amount:Math\.round\(amount\*100\)/);
 assert.match(riderWallet,/accountLast4:account\.account_number\.slice\(-4\)/);
 assert.match(adminWallet,/userWithProfileRole\(req,\["admin"\],db\)/);
 assert.match(adminWallet,/\/transfer\/finalize/);
 assert.match(webhook,/import \{sb,json,err\}/);
 assert.match(webhook,/set_rider_wallet_withdrawal_status/);
});

test("rider wallet does not display a stale balance after an authorization or load failure",()=>{
 assert.match(riderWalletUi,/if\(!response\.ok\)throw Object\.assign\(new Error\(result\.error\|\|"Rider wallet request failed\."\),\{status:response\.status\}\)/);
 assert.match(riderWalletUi,/setWallet\(null\);\s*setAccount\(null\)/);
 assert.match(riderWalletUi,/session is invalid or expired/i);
});
