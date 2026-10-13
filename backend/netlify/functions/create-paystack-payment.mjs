import crypto from "node:crypto";
import {sb,userFromRequest,body,json,err,HttpError} from "./_lib.mjs";

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

async function releaseWalletReservation(db,paymentId){
  const {error}=await db.from("payments")
    .update({status:"failed",paystack_status:"wallet_settlement_failed"})
    .eq("id",paymentId)
    .eq("status","pending");
  if(error)console.error("Could not release failed wallet-credit reservation",error.message);
}

export default async req=>{
  if(req.method==="OPTIONS") return new Response("",{status:204});
  try{
    const user=await userFromRequest(req), b=await body(req), db=sb();
    const {data:o,error}=await db.from("orders").select("id,tracking_number,customer_id,final_price,status,payment_status").eq("id",b.orderId).eq("customer_id",user.id).maybeSingle();
    if(error||!o) throw new Error("Delivery not found");
    const {data:customerProfile,error:customerProfileError}=await db.from("profiles").select("email").eq("id",user.id).maybeSingle();
    if(customerProfileError)throw new Error("Could not retrieve the customer email for Paystack.");
    const paymentEmail=user.email||customerProfile?.email;
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

    const {data:pending,error:pendingError}=await db.from("payments").select("id,reference,amount,wallet_credit").eq("order_id",o.id).eq("status","pending").maybeSingle();
    if(pendingError) throw pendingError;
    if(pending){
      if(Number(pending.amount)===0){
        const {data:settled,error:settlementError}=await db.rpc("settle_customer_wallet_payment",{p_payment_id:pending.id});
        if(settlementError||settled!==true){
          console.error("Could not retry a wallet-only customer payment",settlementError?.message||"No successful settlement was returned");
          await releaseWalletReservation(db,pending.id);
          throw new HttpError("Delivery credit could not be applied. Your balance was not spent; please try again.",409);
        }
        return json({alreadyPaid:true,walletOnly:true,walletCredit:Number(pending.wallet_credit||0)});
      }
      let existingTransaction;
      try{
        existingTransaction=await verifyReference(pending.reference);
      }catch(error){
        console.error("Could not verify the existing pending Paystack payment",error.message);
        throw new HttpError("We couldn't verify your previous payment yet. Please wait and refresh your deliveries before trying again.",503);
      }
      const existingStatus=String(existingTransaction.status||"").toLowerCase();
      if(existingStatus==="success"){
        const applied=await markPayment(existingTransaction);
        if(applied)return json({alreadyPaid:true,reference:pending.reference,walletCredit:Number(pending.wallet_credit||0)});
        throw new HttpError("Paystack reports this payment succeeded, but FemmaDexDrive could not confirm it. Please contact support; do not pay again.",409);
      }
      if(["failed","abandoned","reversed"].includes(existingStatus)){
        await markPayment(existingTransaction);
      }else{
        throw new HttpError("Your previous payment is still being processed. Wait a moment and refresh your deliveries before retrying.",409);
      }
    }

    const reference=`FDD-${o.tracking_number}-${crypto.randomUUID().slice(0,8)}`;
    const {data:reservation,error:reservationError}=await db.rpc("reserve_customer_delivery_payment",{
      p_order_id:o.id,
      p_reference:reference
    });
    if(reservationError){
      if(reservationError.code==="23505"||/payment is already in progress/i.test(reservationError.message||"")) {
        throw new HttpError("A payment is already in progress for this delivery. Wait for its status before trying again.",409);
      }
      console.error("Could not reserve customer wallet credit for payment",reservationError.message);
      throw new HttpError(reservationError.message||"Could not prepare this payment. Please try again.",409);
    }
    const p=Array.isArray(reservation)?reservation[0]:reservation;
    if(!p) throw new Error("Could not create payment record");
    const amountDue=Number(p.amount);
    const walletCredit=Number(p.wallet_credit||0);
    if(!Number.isFinite(amountDue)||amountDue<0||!Number.isFinite(walletCredit)||walletCredit<0||Math.round((amountDue+walletCredit)*100)!==Math.round(approvedPrice*100)) {
      await releaseWalletReservation(db,p.id);
      throw new HttpError("The delivery wallet credit could not be verified. Please contact support before retrying.",409);
    }

    if(amountDue===0){
      const {data:settled,error:settlementError}=await db.rpc("settle_customer_wallet_payment",{p_payment_id:p.id});
      if(settlementError||settled!==true){
        console.error("Could not settle a wallet-only customer payment",settlementError?.message||"No successful settlement was returned");
        await releaseWalletReservation(db,p.id);
        throw new HttpError("Delivery credit could not be applied. Your balance was not spent; please try again.",409);
      }
      return json({alreadyPaid:true,walletOnly:true,walletCredit});
    }
    if(!paymentEmail){
      await releaseWalletReservation(db,p.id);
      throw new HttpError("Add a valid contact email before starting secure payment.",400);
    }

    const origin=process.env.RENDER_EXTERNAL_URL||new URL(req.url).origin;
    let d;
    try{
      d=await paystack("/transaction/initialize",{
        method:"POST",
        body:JSON.stringify({
          amount:Math.round(amountDue*100),
          email:paymentEmail,
          currency:"NGN",
          reference,
          callback_url:new URL("/api/paystack-callback",origin).href,
          metadata:{order_id:o.id,tracking_number:o.tracking_number,wallet_credit:walletCredit},
          channels:["card","bank","ussd","bank_transfer","mobile_money"]
        })
      });
    }catch(error){
      const {error:updateError}=await db.from("payments").update({status:"failed",paystack_status:"initialization_failed"}).eq("id",p.id).eq("status","pending");
      if(updateError) console.error("Could not mark failed payment initialization",updateError.message);
      throw error;
    }
    return json({checkoutUrl:d.data.authorization_url,reference,accessCode:d.data.access_code,amountDue,walletCredit});
  }catch(e){return err(e)}
};
