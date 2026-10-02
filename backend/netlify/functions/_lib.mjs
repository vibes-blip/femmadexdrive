import {createClient} from "@supabase/supabase-js";
export const sb=()=>{
 const url=process.env.SUPABASE_URL;
 const key=process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!url||!key)throw new Error("SUPABASE_URL and the server-only SUPABASE_SECRET_KEY are required.");
 return createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false}});
};
export const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":process.env.APP_ORIGIN||"*","Access-Control-Allow-Headers":"Content-Type, Authorization, x-paystack-signature","Access-Control-Allow-Methods":"GET,POST,OPTIONS"}});
export const body=async req=>{try{return await req.json()}catch{return{}}};
export async function userFromRequest(req){const h=req.headers.get("authorization")||"";const token=h.replace(/^Bearer\s+/i,"");if(!token)throw new Error("Authentication required");const admin=sb();const {data,error}=await admin.auth.getUser(token);if(error||!data.user)throw new Error("Invalid session");return data.user}
export const err=e=>json({error:e?.message||"Server error"},400);
