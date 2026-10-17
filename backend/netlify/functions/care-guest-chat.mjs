import {sb,body,json,err,HttpError} from "./_lib.mjs";
import {createAiReplyResult} from "./care-chat.mjs";
import {guestCareClientAddress,guestCareRateLimitHash,verifyGuestCareToken} from "./_guest-care-security.mjs";

const clean=value=>typeof value==="string"?value.trim().slice(0,1500):"";
const languageTag=/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

export default async request=>{
 if(request.method==="OPTIONS")return new Response("",{status:204});
 try{
  if(request.method!=="POST")throw new HttpError("Method not allowed.",405);
  const secret=process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY;
  const authorization=request.headers.get("authorization")||"";
  const token=authorization.match(/^Bearer\s+(\S+)$/i)?.[1];
  const guest=verifyGuestCareToken(token,secret);
  if(!guest)throw new HttpError("Your guest support session expired. Start a new guest chat; your saved messages will remain on this device.",401);
  const requestBody=await body(request);
  const message=clean(requestBody?.message);
  if(!message)throw new HttpError("Enter a message before sending.",400);
  const prior=Array.isArray(requestBody?.history)?requestBody.history.slice(-10):[];
  const history=prior.map(item=>({
   sender_type:item?.sender_type==="ai"?"ai":"customer",
   body:clean(item?.body)
  })).filter(item=>item.body);
  history.push({sender_type:"customer",body:message});
  const {data:allowed,error}=await sb().rpc("consume_guest_support_rate_limit",{
   p_ip_hash:guestCareRateLimitHash(`ip:${guestCareClientAddress(request)}`,secret),
   p_session_hash:guestCareRateLimitHash(`session:${guest.sessionId}`,secret),
   p_ip_limit:150,
   p_session_limit:40,
   p_window_seconds:600
  });
  if(error){
   console.error("Could not enforce guest support message limits",error.message);
   throw new HttpError("Guest support is temporarily unavailable. Please try again.",503);
  }
  if(allowed!==true)throw new HttpError("You have reached the guest support message limit. Please wait before sending more messages.",429);
  const language=typeof requestBody?.language==="string"&&languageTag.test(requestBody.language)?requestBody.language:"English";
  const aiResult=await createAiReplyResult(history,language);
  return json({mode:"ai",reply:aiResult.reply,fallback:aiResult.fallback,reason:aiResult.reason});
 }catch(error){if(!(error instanceof HttpError))console.error("Guest FemmaDexCare request failed",error.message);return err(error)}
};
