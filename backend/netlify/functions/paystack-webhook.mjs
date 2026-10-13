import crypto from "node:crypto";
import {sb,json,err} from "./_lib.mjs";
import {markPayment,verifyReference} from "./create-paystack-payment.mjs";

export default async req=>{
  if(req.method==="OPTIONS") return new Response("",{status:204});
  try{
    const raw=await req.text();
    const signature=req.headers.get("x-paystack-signature")||"";
    if(!process.env.PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY is not configured.");
    const expected=crypto.createHmac("sha512",process.env.PAYSTACK_SECRET_KEY).update(raw).digest("hex");
    const a=Buffer.from(signature,"utf8"), b=Buffer.from(expected,"utf8");
    if(a.length!==b.length||!crypto.timingSafeEqual(a,b)) return new Response(JSON.stringify({ok:false}),{status:401,headers:{"Content-Type":"application/json"}});
    const payload=JSON.parse(raw||"{}");
    if(payload.event==="charge.success") await markPayment(payload.data);
    if(["transfer.success","transfer.failed","transfer.reversed"].includes(payload.event)){
      const transferStatus={
        "transfer.success":"success",
        "transfer.failed":"failed",
        "transfer.reversed":"reversed"
      }[payload.event];
      const {data:updated,error}=await sb().rpc("set_rider_wallet_withdrawal_status",{
        p_reference:String(payload.data?.reference||""),
        p_status:transferStatus,
        p_transfer_code:payload.data?.transfer_code||null,
        p_status_message:payload.data?.reason||null
      });
      if(error)throw error;
      if(!updated)console.warn("Paystack transfer webhook did not match a rider-wallet withdrawal",{reference:payload.data?.reference,event:payload.event});
    }
    return json({ok:true});
  }catch(e){return err(e)}
};
