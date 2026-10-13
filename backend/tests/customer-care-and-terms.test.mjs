import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {voiceCommand} from "../../frontend/src/voiceCommands.js";

const read=path=>readFileSync(new URL(path,import.meta.url),"utf8");
const careMigration=read("../supabase/migrations/020_customer_care.sql");
const escalationMigration=read("../supabase/migrations/022_support_escalation.sql");
const exceptionMigration=read("../supabase/migrations/021_dispatch_exceptions.sql");
const termsMigration=read("../supabase/migrations/019_dispatch_terms_acceptance.sql");
const careHandler=read("../netlify/functions/care-chat.mjs");
const apiServer=read("../server.mjs");
const bookingUi=read("../../frontend/src/App.jsx");
const locationUi=read("../../frontend/src/MapboxLocation.jsx");
const careUi=read("../../frontend/src/CustomerCare.jsx");
const voiceUi=read("../../frontend/src/VoiceControl.jsx");
const voiceCommands=read("../../frontend/src/voiceCommands.js");
const termsUi=read("../../frontend/src/App.jsx");
const paystack=read("../netlify/functions/create-paystack-payment.mjs");
const homepageStyles=read("../../frontend/src/home.css");

test("customer-care accounts are approved, availability-gated and row-isolated",()=>{
 assert.match(careMigration,/add value if not exists 'customer_care'/);
 assert.match(careMigration,/status text not null default 'pending'/);
 assert.match(careMigration,/a\.status = 'approved' and a\.is_available/);
 assert.match(careMigration,/assigned_agent_id = \(select auth\.uid\(\)\)/);
 assert.match(careMigration,/approve_customer_care_agent/);
 assert.match(careMigration,/set_customer_care_availability/);
 assert.match(careUi,/Application awaiting approval/);
 assert.match(careUi,/approve_customer_care_agent/);
});

test("AI responses are server-configured, authenticated and cannot create or pay for deliveries",()=>{
 assert.match(careHandler,/CARE_AI_API_KEY/);
 assert.match(careHandler,/CARE_AI_MODEL/);
 assert.match(careHandler,/userFromRequest/);
 assert.match(careHandler,/transferConversationId/);
 assert.match(careHandler,/guestUser\.is_anonymous!==true/);
 assert.match(careHandler,/Could not attach your previous support conversation to this account/);
 assert.match(careHandler,/A customer account is required/);
 assert.match(careHandler,/Mandatory service boundaries: Never create, claim to create, cancel, price, pay for, or modify an order/);
 assert.doesNotMatch(careHandler,/create-paystack-payment|create_delivery_quote|orders'\)\.insert/);
 assert.match(apiServer,/\["care-chat", \{ method: "POST"/);
 assert.match(careUi,/fddVoiceBookingRequest/);
 assert.match(careUi,/fddCareConversation/);
 assert.match(bookingUi,/transferGuestCareMemory/);
 assert.match(careUi,/never submits or pays for an order/);
 assert.match(careUi,/Review your transcript before sending/);
 assert.match(careUi,/Microphone access was denied/);
 assert.match(careUi,/Cancel voice/);
 assert.match(careUi,/Mute voice replies/);
});

test("homepage makes booking and AI help prominent and shows the current delivery categories",()=>{
 assert.match(bookingUi,/Book a Delivery/);
 assert.match(bookingUi,/Talk to AI/);
 assert.match(bookingUi,/Become a Rider/);
 assert.match(bookingUi,/Track a Package/);
 assert.match(bookingUi,/signInAnonymously/);
 assert.match(bookingUi,/Contact email \(for your Paystack receipt\)/);
 assert.match(bookingUi,/src="\/images\/Logo-mark\.png"/);
 assert.match(bookingUi,/className="page admin-dashboard"/);
 assert.match(bookingUi,/className="admin-quick-nav"/);
 assert.match(bookingUi,/aria-expanded=\{menu\}/);
 assert.doesNotMatch(bookingUi,/className="logo">FD/);
 assert.doesNotMatch(bookingUi,/double[- ]tap|onDoubleClick/i);
 assert.match(bookingUi,/id:"small-medium",title:"Small & Medium Parcel",description:"Documents, phones, clothes, shoes, groceries and small packages\."/);
 assert.match(bookingUi,/id:"bulky",title:"Large & Bulky Items",description:"Furniture, appliances and large or heavy boxes\."/);
 assert.match(bookingUi,/id:"fast",title:"Fast Delivery — Within 2 Hours"/);
 assert.match(bookingUi,/2-hour target after rider acceptance/);
 assert.match(bookingUi,/Book without creating an account/);
 assert.match(bookingUi,/import VoiceControl from "\.\/VoiceControl\.jsx"/);
 assert.match(bookingUi,/<VoiceControl\/>/);
 assert.match(bookingUi,/fdd-voice-fill/);
 assert.match(voiceUi,/window\.SpeechRecognition\|\|window\.webkitSpeechRecognition/);
 assert.match(voiceCommands,/recipient.*name/);
 assert.match(voiceCommands,/deliveryCategory/);
 assert.match(voiceCommands,/\/book/);
 assert.match(voiceCommands,/\/track/);
 assert.match(voiceUi,/Choose a map suggestion to confirm its location/);
 assert.match(voiceUi,/feminineVoiceNames/);
 assert.match(voiceUi,/recognition\.continuous=true/);
 assert.match(voiceUi,/getUserMedia\(\{audio:true\}\)/);
 assert.match(voiceUi,/Heard request — edit before sending/);
 assert.match(voiceUi,/recognition\.maxAlternatives=4/);
 assert.match(voiceUi,/speakMessage\(reply,selectedLanguage,resume\)/);
 assert.doesNotMatch(voiceUi,/getQuote|create-paystack-payment|\.submit\(/);
 assert.match(careUi,/Start private chat as a guest/);
 assert.match(careUi,/speakReply\(conversationId,message\.body\)/);
 assert.match(homepageStyles,/prefers-reduced-motion:reduce/);
 assert.match(homepageStyles,/max-width:420px/);
});

test("voice commands understand natural phrasing, transcription variations and explain available services",()=>{
 assert.deepEqual(voiceCommand("I need help bookin a delivery"),{
  type:"navigate",
  path:"/book",
  message:"I’ll open the delivery booking form. I can help fill in the details, and you’ll review and confirm the booking yourself."
 });
 assert.equal(voiceCommand("where's my pacel").path,"/track");
 assert.deepEqual(voiceCommand("Please set pickup address to 14 Allen Avenue"),{
  type:"fill",
  field:"pickup",
  value:"14 Allen Avenue"
 });
 assert.deepEqual(voiceCommand("please make my delivery fast"),{
  type:"fill",
  field:"deliveryCategory",
  value:"fast"
 });
 assert.match(voiceCommand("what services do you offer").message,/small and medium parcel delivery/);
 assert.match(voiceCommand("can you help me").message,/small and medium parcel delivery/);
 assert.match(voiceCommand("what is the weather tomorrow").message,/I can help you book a delivery/);
 assert.equal(voiceCommand("join as a rider").path,"/rider");
 assert.equal(voiceCommand("home").path,"/");
});

test("human support is persistent, manually accepted, private and escalated after one minute",()=>{
 assert.match(escalationMigration,/support_status in \('waiting', 'assigned', 'responded', 'resolved'\)/);
 assert.match(escalationMigration,/support_status = 'waiting'[\s\S]*?current_user_role\(\) = 'customer_care'[\s\S]*?a\.is_available/);
 assert.match(escalationMigration,/handled_by = \(select auth\.uid\(\)\)/);
 assert.match(escalationMigration,/sender_type = 'agent'[\s\S]*?c\.handled_by = \(select auth\.uid\(\)\)/);
 assert.match(escalationMigration,/new\.sender_type = 'agent'/);
 assert.match(careHandler,/Your request has been sent to customer care\. Please wait for a response\./);
 assert.match(careHandler,/human_requested_at/);
 assert.match(careUi,/Accept support request/);
 assert.match(careUi,/Resolve support request/);
 assert.match(careUi,/Loading messages…/);
 assert.match(careUi,/No request is opened or assigned automatically/);
 assert.match(read("../netlify/functions/_support-escalation.mjs"),/now-60_000/);
 assert.match(apiServer,/processSupportEscalations/);
});

test("unavailable senders are cancelled without a payment mutation and customer details remain reusable",()=>{
 assert.match(exceptionMigration,/p_issue = 'sender_unavailable'[\s\S]*?status = 'cancelled', rider_id = null/);
 assert.doesNotMatch(exceptionMigration,/set status = 'cancelled',\s*payment_status/);
 assert.match(bookingUi,/Use these details as a starting draft/);
 assert.match(bookingUi,/report_delivery_exception/);
});

test("recipient returns enforce custody, notification window and exact 45-percent redelivery checkout",()=>{
 assert.match(exceptionMigration,/p_issue not in \('sender_unavailable', 'recipient_unavailable'\)/);
 assert.match(exceptionMigration,/order_row\.status not in \('on_the_way', 'at_door'\)/);
 assert.match(exceptionMigration,/admin_record_goods_return/);
 assert.match(exceptionMigration,/round\(order_row\.final_price \* 0\.45, 0\)/);
 assert.match(exceptionMigration,/working_days < 3/);
 assert.match(exceptionMigration,/Africa\/Lagos/);
 assert.match(exceptionMigration,/request_return_redelivery/);
 assert.match(exceptionMigration,/quote_expires_at, status, payment_status,[\s\S]*?'approved', 'unpaid'/);
 assert.match(exceptionMigration,/Operations must resolve the recipient-unavailable report before delivery can continue/);
 assert.match(termsUi,/total redelivery charge, not the original price plus another 45%/);
 assert.match(termsMigration,/delivery_terms_acceptances/);
 assert.match(paystack,/PAYSTACK_SECRET_KEY/);
 assert.match(paystack,/approved_price/);
});

test("quotes require and persist explicit terms acceptance before route creation",()=>{
 assert.match(read("../netlify/functions/quote.mjs"),/request\.termsAccepted!==true/);
 assert.match(read("../netlify/functions/quote.mjs"),/delivery_terms_acceptances/);
 assert.match(bookingUi,/termsVersion:DISPATCH_TERMS_VERSION,termsAccepted:true/);
 assert.match(bookingUi,/I have read and agree to the/);
});

test("the /book entry keeps the authenticated booking flow and exact saved recipient pin",()=>{
 assert.match(bookingUi,/if\(p==="\/book"\)return"book"/);
 assert.match(bookingUi,/page==="customer"\|\|page==="book"/);
 assert.match(bookingUi,/if\(!session\)return <Landing open=\{open\}\/>/);
 assert.match(bookingUi,/name="deliveryCategory"/);
 assert.match(bookingUi,/api\("quote"/);
 assert.match(bookingUi,/api\("create-paystack-payment"/);
 assert.match(locationUi,/Exact customer drop-off pin/);
 assert.match(locationUi,/Latitude: \{Number\(order\.dropoff_latitude\)\.toFixed\(6\)\}/);
 assert.match(locationUi,/Navigate to customer/);
});
