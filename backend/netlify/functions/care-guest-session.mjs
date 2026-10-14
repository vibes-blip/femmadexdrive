import crypto from "node:crypto";
import {sb,json,err,HttpError} from "./_lib.mjs";
import {createGuestCareToken,guestCareClientAddress,guestCareRateLimitHash} from "./_guest-care-security.mjs";

export function createGuestCareSessionHandler({
 getDb=sb,
 getSecret=()=>process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY,
 makeSessionId=()=>crypto.randomUUID()
}={}){
 return async request=>{
  if(request.method==="OPTIONS")return new Response("",{status:204});
  try{
   if(request.method!=="POST")throw new HttpError("Method not allowed.",405);
   const secret=getSecret();
   if(!secret)throw new HttpError("Guest support is not configured. Please try again later.",503);
   const sessionId=makeSessionId();
   const {token,expiresAt}=createGuestCareToken(sessionId,secret);
   const {data:allowed,error}=await getDb().rpc("consume_guest_support_rate_limit",{
    p_ip_hash:guestCareRateLimitHash(`ip:${guestCareClientAddress(request)}`,secret),
    p_session_hash:guestCareRateLimitHash(`session:${sessionId}`,secret),
    p_ip_limit:5,
    p_session_limit:40,
    p_window_seconds:600
   });
   if(error){
    console.error("Could not enforce guest support session limits",error.message);
    throw new HttpError("Guest support is temporarily unavailable. Please try again.",503);
   }
   if(allowed!==true)throw new HttpError("Too many guest support sessions were started from this connection. Please wait before trying again.",429);
   return json({token,expiresAt});
  }catch(error){return err(error)}
 };
}

export default createGuestCareSessionHandler();
