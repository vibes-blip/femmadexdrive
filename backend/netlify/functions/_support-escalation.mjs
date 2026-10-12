import {sb} from "./_lib.mjs";
import {sendAdmin} from "./notify.mjs";

let processing;

export async function processSupportEscalations({db=sb(),notify=sendAdmin,now=Date.now()}={}){
 if(processing)return processing;
 processing=(async()=>{
  const current=new Date(now),cutoff=new Date(now-60_000).toISOString(),staleClaim=new Date(now-60_000).toISOString();
  const {data:requests,error}=await db.from("support_conversations")
   .select("id,customer_id,human_requested_at")
   .in("support_status",["waiting","assigned"])
   .not("human_requested_at","is",null)
   .is("human_response_at",null)
   .is("attention_notified_at",null)
   .lte("human_requested_at",cutoff)
   .or(`escalation_claimed_at.is.null,escalation_claimed_at.lt.${staleClaim}`)
   .limit(50);
  if(error)throw new Error(`Could not load overdue customer-care requests: ${error.message}`);
  let notified=0;
  for(const request of requests||[]){
   const {data:claim,error:claimError}=await db.from("support_conversations")
    .update({escalation_claimed_at:current.toISOString(),attention_notified_at:current.toISOString(),needs_attention:true})
    .eq("id",request.id)
    .in("support_status",["waiting","assigned"])
    .is("human_response_at",null)
    .is("attention_notified_at",null)
    .or(`escalation_claimed_at.is.null,escalation_claimed_at.lt.${staleClaim}`)
    .select("id")
    .maybeSingle();
   if(claimError)throw new Error(`Could not claim customer-care escalation ${request.id}: ${claimError.message}`);
   if(!claim)continue;
   let notificationSent=false;
   try{
    await notify(
     "Customer-care request awaiting attention",
     `<p>Support request <b>${request.id}</b> has had no human response for at least one minute.</p><p>Open the authorized FemmaDexDrive admin or customer-care inbox to accept and respond. AI replies do not count as a human response.</p>`
    );
    notificationSent=true;
    const {error:releaseError}=await db.from("support_conversations")
     .update({escalation_claimed_at:null})
     .eq("id",request.id)
     .is("human_response_at",null)
     .eq("attention_notified_at",current.toISOString());
    if(releaseError)throw new Error(`Could not release customer-care escalation claim ${request.id}: ${releaseError.message}`);
    notified++;
   }catch(error){
    if(!notificationSent){
     const {error:retryError}=await db.from("support_conversations")
      .update({attention_notified_at:null,needs_attention:true})
      .eq("id",request.id)
      .eq("attention_notified_at",current.toISOString())
      .is("human_response_at",null);
     if(retryError)console.error("Could not reset failed customer-care notification",{conversationId:request.id,message:retryError.message});
    }
    console.error(notificationSent?"Customer-care notification sent but its processing claim could not be cleared":"Customer-care attention notification failed; it will be retried after the one-minute claim expires",{conversationId:request.id,message:error.message});
   }
  }
  return notified;
 })();
 try{return await processing}
 finally{processing=null}
}
