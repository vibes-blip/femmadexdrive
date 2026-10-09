import {createClient} from "@supabase/supabase-js";
export const sb=()=>{
 const url=process.env.SUPABASE_URL;
 const key=process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!url||!key)throw new Error("SUPABASE_URL and the server-only SUPABASE_SECRET_KEY are required.");
 return createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false}});
};
export const corsHeaders=(methods="GET, POST, OPTIONS")=>{
 const configuredOrigin=process.env.APP_ORIGIN;
 const origin=configuredOrigin?new URL(configuredOrigin).origin:null;
 return {
  ...(origin?{"Access-Control-Allow-Origin":origin}:{}),
  "Access-Control-Allow-Headers":"Content-Type, Authorization, x-paystack-signature",
  "Access-Control-Allow-Methods":methods,
  "Vary":"Origin"
 };
};
export const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json",...corsHeaders()}});
export class HttpError extends Error{
 constructor(message,status){super(message);this.name="HttpError";this.status=status}
}
export const body=async req=>{
 try{return await req.json()}
 catch{throw new HttpError("Request body must contain valid JSON.",400)}
};
export async function userFromRequest(req){
 const authorization=req.headers.get("authorization")||"";
 const token=authorization.match(/^Bearer\s+(\S+)$/i)?.[1];
 if(!token)throw new HttpError("Authentication required. Sign in and try again.",401);
 let result;
 try{result=await sb().auth.getUser(token)}
 catch{throw new HttpError("Authentication service is temporarily unavailable.",503)}
 if(result.error||!result.data.user){
  const invalidToken=result.error?.status===401||/invalid|expired|jwt|token/i.test(`${result.error?.code||""} ${result.error?.message||""}`);
  if(invalidToken)throw new HttpError("Your session is invalid or expired. Sign in again.",401);
  throw new HttpError("Authentication service is temporarily unavailable.",503);
 }
 return result.data.user;
}
export const err=e=>json({error:e?.message||"Server error"},Number.isInteger(e?.status)?e.status:500);
