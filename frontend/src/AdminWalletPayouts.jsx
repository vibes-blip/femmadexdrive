import React,{useCallback,useEffect,useState} from "react";
import {RefreshCw,WalletCards} from "lucide-react";
import {API_BASE} from "./api.js";

const money=value=>`₦${Number(value||0).toLocaleString("en-NG",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const date=value=>value?new Date(value).toLocaleString([],{dateStyle:"medium",timeStyle:"short"}):"—";
const labels={pending:"Reserved",processing:"Processing",otp_required:"Needs OTP",success:"Paid",failed:"Failed",reversed:"Reversed"};

async function request(action,session,payload={}){
 const response=await fetch(`${API_BASE}/admin-wallet`,{
  method:"POST",
  headers:{"Content-Type":"application/json",Authorization:`Bearer ${session.access_token}`},
  body:JSON.stringify({action,...payload})
 });
 const result=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(result.error||"Admin wallet request failed.");
 return result;
}

export default function AdminWalletPayouts({session,toast}){
 const [withdrawals,setWithdrawals]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState("");
 const [otpById,setOtpById]=useState({}),[busyId,setBusyId]=useState(null);
 const load=useCallback(async()=>{
  setError("");
  try{
   const result=await request("list",session);
   setWithdrawals(result.withdrawals||[]);
  }catch(caught){setError(caught.message||"Could not load rider payouts.")}
  finally{setLoading(false)}
 },[session]);
 useEffect(()=>{
  void load();
  const timer=setInterval(()=>void load(),30000);
  return()=>clearInterval(timer);
 },[load]);
 const finalize=async event=>{
  event.preventDefault();
  const form=new FormData(event.currentTarget);
  const withdrawalId=String(form.get("withdrawalId")||"");
  if(!withdrawalId||busyId)return;
  setBusyId(withdrawalId);setError("");
  try{
   const result=await request("finalize",session,{withdrawalId,otp:otpById[withdrawalId]||""});
   setOtpById(current=>({...current,[withdrawalId]:""}));
   toast(result.message||"Paystack authorization submitted.");
   await load();
  }catch(caught){setError(caught.message||"Could not authorize the payout.")}
  finally{setBusyId(null)}
 };
 return <section className="panel admin-wallet-payouts">
  <div className="panel-head"><div><span className="eyebrow">RIDER EARNINGS</span><h2><WalletCards size={20}/> Paystack withdrawals</h2></div><button className="secondary" onClick={()=>void load()} disabled={loading} aria-label="Refresh rider payouts"><RefreshCw size={16}/> Refresh</button></div>
  {error&&<p className="wallet-error" role="alert">{error}</p>}
  {loading&&withdrawals.length===0?<p role="status">Loading payout records…</p>:withdrawals.length===0?<p className="wallet-note">Rider withdrawal requests will appear here.</p>:<div className="admin-payout-list">{withdrawals.map(item=><article className="admin-payout-row" key={item.id}>
   <div><b>{item.riderName}</b><small>{item.riderEmail||"Rider account"} · {item.bankName} · {item.accountName} · •••• {item.accountLast4}</small></div>
   <strong>{money(item.amount)}</strong>
   <span className={`payout-status payout-${item.status}`}>{labels[item.status]||item.status}</span>
   <small>{date(item.requested_at)} · {item.status_message||item.reference}</small>
   {item.status==="otp_required"&&<form className="admin-payout-otp" onSubmit={finalize}>
    <input type="hidden" name="withdrawalId" value={item.id}/>
    <label>Paystack OTP<input required inputMode="numeric" minLength="4" maxLength="8" pattern="[0-9]{4,8}" value={otpById[item.id]||""} onChange={event=>setOtpById(current=>({...current,[item.id]:event.target.value.replace(/\D/g,"").slice(0,8)}))}/></label>
    <button className="primary" disabled={busyId===item.id}>{busyId===item.id?"Authorizing…":"Authorize transfer"}</button>
   </form>}
  </article>)}</div>}
  <p className="wallet-note">Only administrators can submit Paystack OTPs. Final paid/failed states come from verified Paystack webhooks.</p>
 </section>;
}
