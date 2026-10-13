import {sb,userFromRequest,body,json,err,HttpError} from "./_lib.mjs";

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
  console.error("Paystack withdrawal authorization request failed",error.message);
  throw new HttpError("Paystack could not confirm the authorization request. Check the withdrawal status before retrying.",503);
 }
 const result=await response.json().catch(()=>null);
 if(!response.ok||!result?.status)throw new HttpError(result?.message||"Paystack rejected the withdrawal authorization.",502);
 return result.data;
}

export default async req=>{
 if(req.method==="OPTIONS")return new Response("",{status:204});
 try{
  const user=await userFromRequest(req),request=await body(req),db=sb();
  const {data:profile,error:profileError}=await db.from("profiles").select("role").eq("id",user.id).maybeSingle();
  if(profileError)throw new HttpError("Could not verify your Operations account.",503);
  if(profile?.role!=="admin")throw new HttpError("Administrator access is required to manage Paystack wallet payouts.",403);

  if(request?.action==="list"){
   const {data:withdrawals,error}=await db.from("rider_wallet_withdrawals")
    .select("id,rider_id,amount,status,reference,transfer_code,status_message,requested_at,updated_at")
    .order("requested_at",{ascending:false})
    .limit(100);
   if(error)throw new HttpError("Could not load rider wallet withdrawals.",503);
   const riderIds=[...new Set((withdrawals||[]).map(row=>row.rider_id))];
   const [profiles,riders,accounts]=riderIds.length?await Promise.all([
    db.from("profiles").select("id,full_name,email").in("id",riderIds),
    db.from("riders").select("id,display_name").in("id",riderIds),
    db.from("rider_payout_accounts").select("rider_id,bank_name,account_name,account_number").in("rider_id",riderIds)
   ]):[{data:[]},{data:[]},{data:[]}];
   for(const [label,result] of [["rider profiles",profiles],["rider details",riders],["payout accounts",accounts]]){
    if(result.error)throw new HttpError(`Could not load ${label} for wallet withdrawals.`,503);
   }
   const profileById=new Map((profiles.data||[]).map(row=>[row.id,row]));
   const riderById=new Map((riders.data||[]).map(row=>[row.id,row]));
   const accountById=new Map((accounts.data||[]).map(row=>[row.rider_id,row]));
   return json({withdrawals:(withdrawals||[]).map(row=>{
    const account=accountById.get(row.rider_id);
    return {
     ...row,
     riderName:riderById.get(row.rider_id)?.display_name||profileById.get(row.rider_id)?.full_name||"Rider",
     riderEmail:profileById.get(row.rider_id)?.email||"",
     bankName:account?.bank_name||"",
     accountName:account?.account_name||"",
     accountLast4:account?.account_number?.slice(-4)||""
    };
   })});
  }

  if(request?.action==="finalize"){
   const withdrawalId=String(request.withdrawalId||"");
   const otp=String(request.otp||"").trim();
   if(!withdrawalId||!/^[0-9]{4,8}$/.test(otp))throw new HttpError("Enter the Paystack authorization code.",400);
   const {data:withdrawal,error}=await db.from("rider_wallet_withdrawals")
    .select("id,reference,status,transfer_code")
    .eq("id",withdrawalId)
    .maybeSingle();
   if(error)throw new HttpError("Could not load the wallet withdrawal.",503);
   if(!withdrawal)throw new HttpError("Wallet withdrawal not found.",404);
   if(withdrawal.status!=="otp_required"||!withdrawal.transfer_code)throw new HttpError("This withdrawal is not waiting for Paystack authorization.",409);
   const transfer=await paystack("/transfer/finalize",{
    method:"POST",
    body:JSON.stringify({transfer_code:withdrawal.transfer_code,otp})
   });
   const {error:statusError}=await db.rpc("set_rider_wallet_withdrawal_status",{
    p_reference:withdrawal.reference,
    p_status:String(transfer.status||"").toLowerCase()==="otp"?"otp_required":"processing",
    p_transfer_code:transfer.transfer_code||withdrawal.transfer_code,
    p_status_message:"Paystack authorization submitted; waiting for final transfer confirmation."
   });
   if(statusError){
    console.error("Authorized Paystack payout status could not be saved",{reference:withdrawal.reference,message:statusError.message});
    throw new HttpError("Paystack accepted the OTP, but the app could not record the payout status. Refresh the payout list before retrying.",503);
   }
   return json({ok:true,message:"Paystack authorization submitted. The payout will update after Paystack confirms the transfer."});
  }

  throw new HttpError("Choose a valid admin-wallet action.",400);
 }catch(error){
  if(!(error instanceof HttpError))console.error("Admin wallet request failed",error.message);
  return err(error);
 }
};
