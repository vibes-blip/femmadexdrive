import crypto from "node:crypto";
import {sb,userFromRequest,body,json,err} from "./_lib.mjs";

const paystack=async(path,opts={})=>{
  if(!process.env.PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY is not configured.");
  const r=await fetch(`https://api.paystack.co${path}`,{
    ...opts,
    headers:{Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`,"Content-Type":"application/json",...(opts.headers||{})}
  });
  const d=await r.json();
  if(!r.ok||!d.status) throw new Error(d.message||"Paystack request failed");
  return d;
};

export async function verifyReference(reference){
  const d=await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
  return d.data;
}

export async function markPayment(data){
  const db=sb();
  const reference=String(data?.reference||"");
  if(!reference) return false;
  const amount=Number(data.amount);
  const fees=Number(data.fees);
  const {data:applied,error}=await db.rpc("apply_paystack_payment",{
    p_reference:reference,
    p_status:String(data.status||""),
    p_amount_minor:Number.isFinite(amount)?Math.trunc(amount):-1,
    p_currency:String(data.currency||""),
    p_fee_minor:Number.isFinite(fees)?Math.trunc(fees):0,
    p_payment_method:data.channel||data.authorization?.channel||null,
    p_raw_response:data
  });
  if(error) throw error;
  return applied===true;
}

export default async req=>{
  if(req.method==="OPTIONS") return new Response("",{status:204});
  try{
    const user=await userFromRequest(req), b=await body(req), db=sb();
    const {data:o,error}=await db.from("orders").select("id,tracking_number,customer_id,final_price,status,payment_status").eq("id",b.orderId).eq("customer_id",user.id).maybeSingle();
    if(error||!o) throw new Error("Delivery not found");
    const {data:quote,error:quoteError}=await db.from("delivery_quote_reviews")
      .select("approved_price,status,expires_at")
      .eq("order_id",o.id)
      .eq("customer_id",user.id)
      .maybeSingle();
    if(quoteError) throw quoteError;
    const isReviewedQuote=Boolean(quote);
    if(isReviewedQuote){
      if(quote.status!=="approved"||o.status!=="approved"||o.payment_status!=="unpaid") {
        throw new Error("Operations has not approved this delivery quote for payment");
      }
      if(!quote.approved_price||Number(quote.approved_price)<=0||Number(quote.approved_price)!==Number(o.final_price)) {
        throw new Error("The approved delivery price is invalid. Contact operations.");
      }
      if(!quote.expires_at||new Date(quote.expires_at).getTime()<=Date.now()) {
        throw new Error("This approved delivery quote has expired. Please request a new quote.");
      }
    }else if(o.status!=="awaiting_payment"||o.payment_status!=="unpaid"){
      throw new Error("Operations has not released this delivery for payment yet");
    }
    const approvedPrice=isReviewedQuote?Number(quote.approved_price):Number(o.final_price);
    if(!Number.isFinite(approvedPrice)||approvedPrice<=0) throw new Error("Invalid delivery price");

    const {data:pending,error:pendingError}=await db.from("payments").select("id").eq("order_id",o.id).eq("status","pending").maybeSingle();
    if(pendingError) throw pendingError;
    if(pending) throw new Error("A payment is already in progress for this delivery. Wait for its status before trying again.");

    const reference=`FDD-${o.tracking_number}-${crypto.randomUUID().slice(0,8)}`;
    const {data:p,error:pe}=await db.from("payments").insert({order_id:o.id,customer_id:user.id,amount:approvedPrice,currency:"NGN",status:"pending",reference}).select("*").single();
    if(pe){
      if(pe.code==="23505") throw new Error("A payment is already in progress for this delivery. Wait for its status before trying again.");
      throw pe;
    }
    if(!p) throw new Error("Could not create payment record");

    const origin=new URL(req.url).origin;
    let d;
    try{
      d=await paystack("/transaction/initialize",{
        method:"POST",
        body:JSON.stringify({
          amount:Math.round(approvedPrice*100),
          email:user.email,
          currency:"NGN",
          reference,
          callback_url:process.env.PAYSTACK_CALLBACK_URL||`${origin}/api/paystack-callback`,
          metadata:{order_id:o.id,tracking_number:o.tracking_number},
          channels:["card","bank","ussd","bank_transfer","mobile_money"]
        })
      });
    }catch(error){
      const {error:updateError}=await db.from("payments").update({status:"failed",paystack_status:"initialization_failed"}).eq("id",p.id).eq("status","pending");
      if(updateError) console.error("Could not mark failed payment initialization",updateError.message);
      throw error;
    }
    return json({checkoutUrl:d.data.authorization_url,reference,accessCode:d.data.access_code});
  }catch(e){return err(e)}
};
