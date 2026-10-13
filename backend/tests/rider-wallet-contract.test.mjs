import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const read=path=>readFileSync(new URL(path,import.meta.url),"utf8");
const migration=read("../supabase/migrations/023_rider_wallet_and_paystack_transfers.sql");
const riderWallet=read("../netlify/functions/rider-wallet.mjs");
const adminWallet=read("../netlify/functions/admin-wallet.mjs");
const webhook=read("../netlify/functions/paystack-webhook.mjs");

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
 assert.match(adminWallet,/profile\?\.role!=="admin"/);
 assert.match(adminWallet,/\/transfer\/finalize/);
 assert.match(webhook,/import \{sb,json,err\}/);
 assert.match(webhook,/set_rider_wallet_withdrawal_status/);
});
