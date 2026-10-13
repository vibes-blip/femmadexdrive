import crypto from "node:crypto";
import {sb,userFromRequest,body,json,err,HttpError} from "./_lib.mjs";

class PaystackRejectedError extends HttpError {
 constructor(message){super(message,502);this.name="PaystackRejectedError"}
}
class PaystackOutcomeUnknownError extends HttpError {
 constructor(message){super(message,503);this.name="PaystackOutcomeUnknownError"}
}

async function paystack(path,options={}){
 if(!process.env.PAYSTACK_SECRET_KEY)throw new HttpError("Paystack transfers are not configured on the server.",503);
 let response;
 try{
  response=await fetch(`https://api.paystack.co${path}`,{
   ...options,
   headers:{
    Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    "Content-Type":"application/json",
    ...(options.headers||{})
   },
   signal:AbortSignal.timeout(20000)
  });
 }catch(error){
  throw new PaystackOutcomeUnknownError(error.message||"Paystack did not confirm the transfer request.");
 }
 let result;
 try{result=await response.json()}
 catch(error){throw new PaystackOutcomeUnknownError(error.message||"Paystack returned an unreadable transfer response.")}
 if(!response.ok||!result.status)throw new PaystackRejectedError(result.message||"Paystack rejected the request.");
 return result.data;
}

async function currentRider(db,user){
 const {data:profile,error}=await db.from("profiles").select("role").eq("id",user.id).maybeSingle();
 if(error)throw new HttpError("Could not verify your rider account.",503);
 if(profile?.role!=="rider")throw new HttpError("A rider account is required to use the rider wallet.",403);
 return user.id;
}

async function bankAccount(db,riderId){
 const {data,error}=await db.from("rider_payout_accounts")
  .select("bank_code,bank_name,account_name,account_number,recipient_code")
  .eq("rider_id",riderId)
  .maybeSingle();
 if(error)throw new HttpError("Could not load your payout account.",503);
 return data;
}

function maskedAccount(account){
 if(!account)return null;
 return {
  bankCode:account.bank_code,
  bankName:account.bank_name,
  accountName:account.account_name,
  accountLast4:account.account_number.slice(-4)
 };
}

export default async req=>{
 if(req.method==="OPTIONS")return new Response("",{status:204});
 try{
  const user=await userFromRequest(req),request=await body(req),db=sb();
  const riderId=await currentRider(db,user);
  const action=String(request?.action||"");

  if(action==="summary"){
   const [{data:snapshot,error:snapshotError},account]=await Promise.all([
    db.rpc("get_rider_wallet_snapshot",{p_rider_id:riderId}),
    bankAccount(db,riderId)
   ]);
   if(snapshotError)throw new HttpError("Could not load your rider wallet.",503);
   return json({wallet:snapshot,account:maskedAccount(account)});
  }

  if(action==="banks"){
   const data=await paystack("/bank?currency=NGN&perPage=100");
   return json({banks:(data||[]).filter(bank=>bank.active!==false).map(bank=>({
    code:String(bank.code||""),
    name:String(bank.name||"")
   })).filter(bank=>bank.code&&bank.name)});
  }

  if(action==="save-account"){
   const bankCode=String(request.bankCode||"").trim();
   const accountNumber=String(request.accountNumber||"").trim();
   if(!/^[0-9]{10}$/.test(accountNumber))throw new HttpError("Enter a valid 10-digit Nigerian bank account number.",400);
   if(!bankCode||bankCode.length>20)throw new HttpError("Select a supported Nigerian bank.",400);
   const {data:activePayouts,error:activePayoutError}=await db.from("rider_wallet_withdrawals")
    .select("id")
    .eq("rider_id",riderId)
    .in("status",["pending","processing","otp_required"])
    .limit(1);
   if(activePayoutError)throw new HttpError("Could not check whether a withdrawal is already in progress.",503);
   if(activePayouts?.length)throw new HttpError("Wait for the current Paystack withdrawal to finish before changing payout details.",409);

   const [resolved,banks]=await Promise.all([
    paystack(`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`),
    paystack("/bank?currency=NGN&perPage=100")
   ]);
   const bank=(banks||[]).find(item=>String(item.code)===bankCode);
   if(!bank)throw new HttpError("The selected bank is not available for Paystack transfers.",400);
   const recipient=await paystack("/transferrecipient",{
    method:"POST",
    body:JSON.stringify({
     type:"nuban",
     name:resolved.account_name,
     account_number:accountNumber,
     bank_code:bankCode,
     currency:"NGN"
    })
   });
   if(!recipient?.recipient_code)throw new HttpError("Paystack did not return a verified payout recipient.",502);
   const {error:saveError}=await db.from("rider_payout_accounts").upsert({
    rider_id:riderId,
    bank_code:bankCode,
    bank_name:String(bank.name),
    account_name:String(resolved.account_name),
    account_number:accountNumber,
    recipient_code:String(recipient.recipient_code),
    updated_at:new Date().toISOString()
   },{onConflict:"rider_id"});
   if(saveError){
    console.error("Could not save verified rider payout account",{code:saveError.code,message:saveError.message});
    throw new HttpError("The bank account was verified but could not be saved. Please retry.",503);
   }
   return json({account:maskedAccount({
    bank_code:bankCode,
    bank_name:String(bank.name),
    account_name:String(resolved.account_name),
    account_number:accountNumber
   })});
  }

  if(action==="withdraw"){
   const amount=Number(request.amount);
   if(!Number.isFinite(amount)||amount<=0||Math.round(amount*100)!==amount*100){
    throw new HttpError("Enter a valid withdrawal amount in naira.",400);
   }
   const account=await bankAccount(db,riderId);
   if(!account)throw new HttpError("Add and verify a payout bank account before withdrawing.",409);
   const reference=`FDD-RIDER-${crypto.randomUUID()}`;
   const {data:withdrawal,error:reserveError}=await db.rpc("reserve_rider_wallet_withdrawal",{
    p_rider_id:riderId,
    p_amount:amount,
    p_reference:reference
   });
   if(reserveError)throw new HttpError(reserveError.message,409);
   if(!withdrawal?.id)throw new HttpError("The withdrawal reservation could not be confirmed. Refresh your wallet before retrying.",502);

   let transfer;
   try{
    transfer=await paystack("/transfer",{
     method:"POST",
     body:JSON.stringify({
      source:"balance",
      amount:Math.round(amount*100),
      recipient:account.recipient_code,
      reason:"FemmaDexDrive rider wallet withdrawal",
      reference
     })
    });
   }catch(error){
    const uncertain=error instanceof PaystackOutcomeUnknownError;
    const status=uncertain?"processing":"failed";
    const message=uncertain
     ?"Paystack has not confirmed this transfer yet. The amount remains reserved while the transfer is reconciled."
     :error.message;
    const {error:statusError}=await db.rpc("set_rider_wallet_withdrawal_status",{
     p_reference:reference,
     p_status:status,
     p_status_message:message
    });
    if(statusError)console.error("Could not record the Paystack withdrawal outcome",{reference,message:statusError.message});
    if(uncertain)throw new HttpError(message,503);
    console.error("Paystack rejected a rider withdrawal",{reference,message});
    throw new HttpError(message,502);
   }

   const requiresOtp=String(transfer.status||"").toLowerCase()==="otp";
   const nextStatus=requiresOtp?"otp_required":"processing";
   const statusMessage=requiresOtp
    ?"Paystack requires an account-owner OTP before this transfer can continue."
    :"Transfer submitted; waiting for Paystack's final confirmation.";
   const {error:statusError}=await db.rpc("set_rider_wallet_withdrawal_status",{
    p_reference:reference,
    p_status:nextStatus,
    p_transfer_code:transfer.transfer_code||null,
    p_status_message:statusMessage
   });
   if(statusError){
    console.error("Paystack accepted a rider withdrawal but its status could not be saved",{reference,message:statusError.message});
    throw new HttpError("Paystack accepted the withdrawal, but the app could not record its status. Contact Operations and do not submit another withdrawal.",503);
   }
   return json({
    withdrawal:{id:withdrawal.id,amount,status:nextStatus,reference},
    message:requiresOtp?"Withdrawal reserved. Operations must complete Paystack's OTP step.":"Withdrawal sent to Paystack for processing."
   });
  }

  throw new HttpError("Choose a valid rider-wallet action.",400);
 }catch(error){
  if(!(error instanceof HttpError))console.error("Rider wallet request failed",error.message);
  return err(error);
 }
};
