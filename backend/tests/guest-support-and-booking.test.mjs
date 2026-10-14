import test from "node:test";
import assert from "node:assert/strict";
import {createGuestCareToken,guestCareRateLimitHash,verifyGuestCareToken} from "../netlify/functions/_guest-care-security.mjs";
import {createGuestCareSessionHandler} from "../netlify/functions/care-guest-session.mjs";
import {AI_UNAVAILABLE_REPLY,createAiReplyResult} from "../netlify/functions/care-chat.mjs";
import {HttpError} from "../netlify/functions/_lib.mjs";
import {bookingDetailsFromConversation} from "../../frontend/src/bookingAssistant.js";
import {readFileSync} from "node:fs";

const read=path=>readFileSync(new URL(path,import.meta.url),"utf8");

test("guest care tokens are signed, bounded to twelve hours and tamper resistant",()=>{
 const now=Date.now(),secret="test-only-secret",sessionId="2af3b685-6188-4f7c-9ae3-10893b23f912";
 const {token,expiresAt}=createGuestCareToken(sessionId,secret,now);
 assert.equal(expiresAt,now+12*60*60*1000);
 assert.deepEqual(verifyGuestCareToken(token,secret,now),{sessionId,expiresAt});
 assert.equal(verifyGuestCareToken(token,secret,now+12*60*60*1000),null);
 assert.equal(verifyGuestCareToken(token.replace("2af3","3bf4"),secret,now),null);
 assert.equal(verifyGuestCareToken(token,"wrong-secret",now),null);
});

test("guest care rate-limit keys are keyed hashes rather than raw client identifiers",()=>{
 const secret="test-only-secret";
 const first=guestCareRateLimitHash("ip:203.0.113.5",secret);
 assert.match(first,/^[0-9a-f]{64}$/);
 assert.equal(first,guestCareRateLimitHash("ip:203.0.113.5",secret));
 assert.notEqual(first,guestCareRateLimitHash("ip:203.0.113.6",secret));
 assert.notEqual(first,guestCareRateLimitHash("ip:203.0.113.5","rotated-secret"));
});

test("guest chat session creation checks the rate-limit result it actually receives",async()=>{
 const sessionId="2af3b685-6188-4f7c-9ae3-10893b23f912";
 const handler=createGuestCareSessionHandler({
  getSecret:()=>"test-only-secret",
  makeSessionId:()=>sessionId,
  getDb:()=>({rpc:async()=>({data:true,error:null})})
 });
 const response=await handler(new Request("https://femmadexdrive.test/api/care-guest-session",{method:"POST"}));
 assert.equal(response.status,200);
 const result=await response.json();
 assert.deepEqual(verifyGuestCareToken(result.token,"test-only-secret"),{
  sessionId,
  expiresAt:result.expiresAt
 });

 const limited=createGuestCareSessionHandler({
  getSecret:()=>"test-only-secret",
  getDb:()=>({rpc:async()=>({data:false,error:null})})
 });
 const limitedResponse=await limited(new Request("https://femmadexdrive.test/api/care-guest-session",{method:"POST"}));
 assert.equal(limitedResponse.status,429);
});

test("AI service outages produce a saved fallback and trigger customer-care follow-up",async()=>{
 const result=await createAiReplyResult([{sender_type:"customer",body:"Where is my delivery?"}],"en-NG",async()=>{
  throw new HttpError("AI provider unavailable.",503);
 });
 assert.deepEqual(result,{reply:AI_UNAVAILABLE_REPLY,fallback:true});
 await assert.rejects(createAiReplyResult([],"en-NG",async()=>{throw new Error("unexpected failure")}),/unexpected failure/);
 const careHandler=read("../netlify/functions/care-chat.mjs");
 assert.match(careHandler,/support_status:"waiting",human_requested_at:updatedAt,needs_attention:true/);
 assert.match(careHandler,/sender_type:"ai",body:reply/);
});

test("booking assistant extracts delivery details from multiple customer messages",()=>{
 const details=bookingDetailsFromConversation([
  {sender_type:"customer",body:"I need to book a delivery from Ikeja to Victoria Island."},
  {sender_type:"ai",body:"What package will you send?"},
  {sender_type:"customer",body:"A phone."},
  {sender_type:"ai",body:"What is the recipient name?"},
  {sender_type:"customer",body:"Ada Okafor and the number is +234 801 234 5678."},
  {sender_type:"ai",body:"What package category do you need?"},
  {sender_type:"customer",body:"The package is small."}
 ]);
 assert.equal(details.pickup,"Ikeja");
 assert.equal(details.dropoff,"Victoria Island");
 assert.equal(details.recipientName,"Ada Okafor");
 assert.equal(details.recipientPhone,"+234 801 234 5678");
 assert.equal(details.packageCategory,"small");
 assert.equal(details.description,"A phone.");
});

test("guest booking drafts stop at authenticated quote submission and guest chat is rate limited",()=>{
 const app=read("../../frontend/src/App.jsx");
 const guestChat=read("../netlify/functions/care-guest-chat.mjs");
 const sessionHandler=read("../netlify/functions/care-guest-session.mjs");
 const migration=read("../supabase/migrations/024_guest_support_rate_limits.sql");
 assert.match(app,/allowGuestBooking/);
 assert.match(app,/Your delivery draft is saved on this device/);
 assert.match(app,/fddBookingDraft:guest/);
 assert.match(app,/bookingDetailsFromConversation/);
 assert.doesNotMatch(app,/signInAnonymously/);
 assert.match(guestChat,/verifyGuestCareToken/);
 assert.match(guestChat,/consume_guest_support_rate_limit/);
 assert.match(sessionHandler,/consume_guest_support_rate_limit/);
 assert.match(migration,/to service_role/);
 assert.match(migration,/alter table public\.guest_support_rate_limits enable row level security/);
 assert.match(read("../../frontend/src/CustomerCare.jsx"),/response\.status===401/);
 assert.match(read("../../frontend/src/CustomerCare.jsx"),/Your conversation history has been kept/);
 assert.match(read("../server.mjs"),/headers\.delete\("x-nf-client-connection-ip"\)/);
 assert.match(read("../netlify/functions/_guest-care-security.mjs"),/x-fdd-client-address/);
});

test("cashback is only awarded on the seventh verified completed delivery and wallet redemptions are atomic",()=>{
 const migration=read("../supabase/migrations/025_customer_delivery_rewards.sql");
 const paymentHandler=read("../netlify/functions/create-paystack-payment.mjs");
 assert.match(migration,/completed_count=7/);
 assert.match(migration,/new\.final_price\*0\.02/);
 assert.match(migration,/status='completed'\s+and payment_status='paid'/);
 assert.match(migration,/reserve_customer_delivery_payment/);
 assert.match(migration,/settle_customer_wallet_payment/);
 assert.match(migration,/insert into public\.customer_wallet_ledger\(customer_id,entry_type,amount,source_order_id\)/);
 assert.match(paymentHandler,/settle_customer_wallet_payment/);
 assert.match(paymentHandler,/walletOnly:true/);
 assert.match(paymentHandler,/if\(Number\(pending\.amount\)===0\)/);
 assert.match(paymentHandler,/releaseWalletReservation/);
 assert.match(paymentHandler,/await releaseWalletReservation\(db,p\.id\);\s*throw new HttpError\("Add a valid contact email/);
 assert.match(read("../server.mjs"),/headers\.set\("x-fdd-client-address"/);
 assert.doesNotMatch(migration,/withdraw|cashout/i);
});
