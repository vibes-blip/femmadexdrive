import {sb,body,json,err,HttpError,userFromRequest} from "./_lib.mjs";
import {sendAdmin} from "./notify.mjs";

const DEFAULT_SYSTEM_PROMPT=`You are FemmaDexCare, FemmaDexDrive's customer-support assistant.
Help customers understand dispatch booking, delivery categories, delivery stages, customer-care support and the published failed-delivery terms.
For a booking conversation, guide the customer to identify pickup, destination, parcel category, package details and recipient, one step at a time. The customer must review and enter all details in the existing authenticated booking dashboard at https://femmadexdrive.netlify.app/book.
Small & Medium Parcels include documents, phones, clothes, shoes, groceries and small packages, with standard pricing and regular delivery. Large & Bulky Items include furniture, appliances and large or heavy boxes; a suitable vehicle is required and the booking is subject to approval. Fast Delivery is for urgent small and medium parcels, costs 2x standard price under the existing quote rules, and has a 2-hour target after rider acceptance, not a guarantee.
The route-based quote and Operations-approved price in the dashboard are authoritative; do not invent ordinary prices or ETAs.
If discussing a recipient-unavailable redelivery, explain that the proposed published policy is 45% of the original dispatch price as the total redelivery charge, subject to Operations confirmation.
Keep replies concise and friendly.`;
const REQUIRED_AI_BOUNDARIES=`Mandatory service boundaries: Never create, claim to create, cancel, price, pay for, or modify an order. Never claim a payment succeeded, issue a refund, or promise a rider. Ask customers to complete all orders through https://femmadexdrive.netlify.app/book. Do not provide legal, safety-critical, or medical advice. Never pretend to be a human.`;
const SERVICE_KNOWLEDGE=`FemmaDexDrive service facts: Small & Medium Parcels cover documents, phones, clothes, shoes, groceries and small packages; standard pricing and regular delivery. Large & Bulky Items cover furniture, appliances and large or heavy boxes; a suitable vehicle is required and dispatch is subject to approval. Fast Delivery is for urgent small and medium parcels, costs 2x the standard price under the existing quote rules, and has a 2-hour target after rider acceptance, not a guarantee. For conversational booking help, ask for pickup, destination, parcel category, item details and recipient one step at a time, then direct the customer to confirm them in the existing booking dashboard. The route-based quote and Operations-approved price in the dashboard are authoritative; never invent prices, order status, rider availability or payment results.`;

const cleanMessage=value=>typeof value==="string"?value.trim().slice(0,1500):"";
const safeReply=value=>typeof value==="string"?value.trim().slice(0,2000):"";

async function createAiReply(messages,language){
 const apiKey=process.env.CARE_AI_API_KEY;
 const model=process.env.CARE_AI_MODEL;
 if(!apiKey||!model)throw new HttpError("AI customer care is not configured yet. Please use the normal booking dashboard or try human support later.",503);
 const endpoint=process.env.CARE_AI_API_URL||"https://api.openai.com/v1/chat/completions";
 let response;
 try{
  response=await fetch(endpoint,{
   method:"POST",
   headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},
   signal:AbortSignal.timeout(20000),
   body:JSON.stringify({
    model,
    temperature:0.3,
    max_tokens:350,
    messages:[
     {role:"system",content:`${process.env.CARE_AI_SYSTEM_PROMPT||DEFAULT_SYSTEM_PROMPT}\n\n${SERVICE_KNOWLEDGE}\n\n${REQUIRED_AI_BOUNDARIES}\nRespond in ${language||"English"} unless the customer asks otherwise.`},
     ...messages.map(message=>({
      role:message.sender_type==="ai"?"assistant":"user",
      content:message.body
     }))
    ]
   })
  });
 }catch(error){
  console.error("FemmaDexCare AI provider request failed",error.message);
  throw new HttpError("AI customer care is temporarily unavailable. Please try again or ask for a human agent.",503);
 }
 if(!response.ok){
  console.error("FemmaDexCare AI provider returned an error",{status:response.status});
  throw new HttpError("AI customer care is temporarily unavailable. Please try again or ask for a human agent.",503);
 }
 let result;
 try{result=await response.json()}catch{
  throw new HttpError("AI customer care returned an invalid response. Please try again or ask for a human agent.",502);
 }
 const reply=safeReply(result?.choices?.[0]?.message?.content);
 if(!reply)throw new HttpError("AI customer care could not form a response. Please try again or ask for a human agent.",502);
 return reply;
}

export default async req=>{
 if(req.method==="OPTIONS")return new Response("",{status:204});
 try{
  const user=await userFromRequest(req);
  const request=await body(req);
  const message=cleanMessage(request?.message);
  if(!message)throw new HttpError("Enter a message before sending.",400);
  if(typeof request?.conversationId!=="string")throw new HttpError("Start a support conversation before sending a message.",400);
  const db=sb();
  const {data:profile,error:profileError}=await db.from("profiles").select("role").eq("id",user.id).maybeSingle();
  if(profileError)throw new HttpError("Your account could not be verified. Please try again.",503);
  if(profile?.role!=="customer")throw new HttpError("A customer account is required to use AI customer care.",403);

  const {data:conversation,error:conversationError}=await db.from("support_conversations")
   .select("id,customer_id,assigned_agent_id,handled_by,status,support_status,human_requested_at")
   .eq("id",request.conversationId)
   .eq("customer_id",user.id)
   .maybeSingle();
  if(conversationError)throw new HttpError("Could not load your support conversation.",503);
  if(!conversation||conversation.status==="closed")throw new HttpError("This support conversation is no longer active. Start a new conversation.",404);

  if(request.requestHuman===true&&conversation.handled_by&&["assigned","responded"].includes(conversation.support_status)){
   const {error:insertError}=await db.from("support_messages").insert({
    conversation_id:conversation.id,sender_id:user.id,sender_type:"customer",body:message
   });
   if(insertError)throw new HttpError("Your message could not be sent. Please try again.",503);
   return json({mode:"human",reply:"Your message was sent to the assigned customer-care team."});
  }

  if(request.requestHuman===true){
   if(conversation.support_status==="resolved")throw new HttpError("This support request is resolved. Start a new chat to contact customer care.",409);
   const firstRequest=!conversation.human_requested_at;
   if(firstRequest){
    const requestedAt=new Date().toISOString();
    const {data:updated,error:updateError}=await db.from("support_conversations")
     .update({
      support_status:"waiting",
      human_requested_at:requestedAt,
      human_response_at:null,
      escalation_claimed_at:null,
      attention_notified_at:null,
      needs_attention:false,
      resolved_at:null,
      handled_by:null,
      assigned_agent_id:null,
      status:"ai",
      updated_at:requestedAt
     })
     .eq("id",conversation.id)
     .eq("customer_id",user.id)
     .is("human_requested_at",null)
     .neq("support_status","resolved")
     .select("id")
     .maybeSingle();
    if(updateError)throw new HttpError("Could not send your customer-care request. Please try again.",503);
    if(updated){
     const {error:insertError}=await db.from("support_messages").insert({
      conversation_id:conversation.id,sender_id:user.id,sender_type:"customer",body:message
     });
     if(insertError)throw new HttpError("Your support request was recorded but the message could not be saved. Please retry.",503);
     try{
      await sendAdmin(
       "New FemmaDexDrive customer-care request",
       `<p>A customer has requested a human response.</p><p>Conversation: <b>${conversation.id}</b></p><p>Please open the authorized admin or customer-care inbox and accept the request.</p>`
      );
     }catch(error){console.error("Initial customer-care notification failed",{conversationId:conversation.id,message:error.message})}
    }
   }
   return json({mode:"human",reply:"Your request has been sent to customer care. Please wait for a response."});
  }

  if(conversation.handled_by&&["assigned","responded"].includes(conversation.support_status)){
   const {error:insertError}=await db.from("support_messages").insert({
    conversation_id:conversation.id,sender_id:user.id,sender_type:"customer",body:message
   });
   if(insertError)throw new HttpError("Your message could not be sent. Please try again.",503);
   return json({mode:"human",reply:null});
  }

  const {data:agent,error:agentError}=conversation.assigned_agent_id
   ?await db.from("customer_care_agents").select("id,status,is_available").eq("id",conversation.assigned_agent_id).maybeSingle()
   :{data:null,error:null};
  if(agentError)throw new HttpError("Could not check customer-care availability.",503);
  if(agent?.status==="approved"&&agent.is_available&&conversation.status==="active"){
   const {error:insertError}=await db.from("support_messages").insert({
    conversation_id:conversation.id,sender_id:user.id,sender_type:"customer",body:message
   });
   if(insertError)throw new HttpError("Your message could not be sent. Please try again.",503);
   return json({mode:"human",reply:null});
  }

  const {data:history,error:historyError}=await db.from("support_messages")
   .select("sender_type,body")
   .eq("conversation_id",conversation.id)
   .order("created_at",{ascending:false})
   .limit(11);
  if(historyError)throw new HttpError("Could not load the support conversation history.",503);
  const messages=[...(history||[]).reverse(),{sender_type:"customer",body:message}];
  const reply=await createAiReply(messages,request.language);
  const {error:writeError}=await db.from("support_messages").insert([
   {conversation_id:conversation.id,sender_id:user.id,sender_type:"customer",body:message},
   {conversation_id:conversation.id,sender_id:null,sender_type:"ai",body:reply}
  ]);
  if(writeError)throw new HttpError("The AI response was prepared but the conversation could not be saved. Please contact customer care.",503);
  const {error:conversationUpdateError}=await db.from("support_conversations")
   .update({status:"ai",updated_at:new Date().toISOString()})
   .eq("id",conversation.id).eq("customer_id",user.id);
  if(conversationUpdateError)console.error("AI conversation reply was saved but its latest activity time was not updated",conversationUpdateError.message);
  return json({mode:"ai",reply});
 }catch(error){
  if(!(error instanceof HttpError))console.error("FemmaDexCare request failed",error.message);
  return err(error);
 }
};
