import React,{useCallback,useEffect,useState} from "react";
import {ArrowDownToLine,Building2,Clock3,RefreshCw,WalletCards} from "lucide-react";
import {API_BASE} from "./api.js";

const money=value=>`₦${Number(value||0).toLocaleString("en-NG",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const date=value=>value?new Date(value).toLocaleString([],{dateStyle:"medium",timeStyle:"short"}):"—";
const statusLabel=status=>({
 pending:"Reserved",
 processing:"Processing",
 otp_required:"Needs Operations OTP",
 success:"Paid",
 failed:"Failed",
 reversed:"Reversed"
}[status]||status);

async function request(action,session,payload={}){
 const response=await fetch(`${API_BASE}/rider-wallet`,{
  method:"POST",
  headers:{"Content-Type":"application/json",Authorization:`Bearer ${session.access_token}`},
  body:JSON.stringify({action,...payload})
 });
 const result=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(result.error||"Rider wallet request failed.");
 return result;
}

export default function RiderWallet({session,toast}){
 const [wallet,setWallet]=useState(null),[account,setAccount]=useState(null),[banks,setBanks]=useState([]),[loading,setLoading]=useState(true);
 const [error,setError]=useState(""),[bankError,setBankError]=useState(""),[accountForm,setAccountForm]=useState(false);
 const [bankCode,setBankCode]=useState(""),[accountNumber,setAccountNumber]=useState(""),[amount,setAmount]=useState("");
 const [savingAccount,setSavingAccount]=useState(false),[withdrawing,setWithdrawing]=useState(false);

 const load=useCallback(async()=>{
  setError("");
  try{
   const result=await request("summary",session);
   setWallet(result.wallet||null);
   setAccount(result.account||null);
  }catch(caught){setError(caught.message||"Could not load the rider wallet.")}
  finally{setLoading(false)}
 },[session]);
 useEffect(()=>{
  void load();
  const timer=setInterval(()=>void load(),30000);
  return()=>clearInterval(timer);
 },[load]);

 const openAccountForm=async()=>{
  setAccountForm(true);setBankError("");
  if(banks.length)return;
  try{
   const result=await request("banks",session);
   setBanks(result.banks||[]);
  }catch(caught){setBankError(caught.message||"Could not load the supported banks.")}
 };
 const saveAccount=async event=>{
  event.preventDefault();
  if(savingAccount)return;
  setSavingAccount(true);setBankError("");
  try{
   const result=await request("save-account",session,{bankCode,accountNumber});
   setAccount(result.account||null);setAccountNumber("");setBankCode("");setAccountForm(false);
   toast("Paystack verified and saved your payout account.");
   await load();
  }catch(caught){setBankError(caught.message||"Could not save your payout account.")}
  finally{setSavingAccount(false)}
 };
 const withdraw=async event=>{
  event.preventDefault();
  if(withdrawing)return;
  const value=Number(amount);
  if(!Number.isFinite(value)||value<=0)return setError("Enter a valid withdrawal amount.");
  if(value>Number(wallet?.availableBalance||0))return setError("Withdrawal amount exceeds your available balance.");
  if(!window.confirm(`Withdraw ${money(value)} to your verified bank account?`))return;
  setWithdrawing(true);setError("");
  try{
   const result=await request("withdraw",session,{amount:value});
   setAmount("");
   toast(result.message||"Withdrawal submitted to Paystack.");
   await load();
  }catch(caught){setError(caught.message||"Could not submit the withdrawal.")}
  finally{setWithdrawing(false)}
 };

 const entries=wallet?.ledger||[];
 const withdrawals=wallet?.withdrawals||[];
 const completed=Number(wallet?.completedDeliveries||0);
 return <section className="panel rider-wallet" aria-labelledby="rider-wallet-title">
  <div className="rider-wallet-head">
   <div><span className="eyebrow">RIDER WALLET</span><h2 id="rider-wallet-title"><WalletCards size={22}/> Earnings & withdrawals</h2></div>
   <button className="secondary" type="button" onClick={()=>void load()} disabled={loading} aria-label="Refresh rider wallet"><RefreshCw size={16}/> Refresh</button>
  </div>
  {loading&&!wallet?<p role="status">Loading wallet…</p>:error&&!wallet?<div className="wallet-error" role="alert"><p>{error}</p><button className="secondary" onClick={()=>void load()}>Retry</button></div>:<>
   {error&&<p className="wallet-error" role="alert">{error}</p>}
   <div className="wallet-metrics">
    <article className="wallet-metric wallet-available"><span>Rider wallet</span><b>{money(wallet?.availableBalance)}</b><small>Available for withdrawal</small></article>
    <article className="wallet-metric"><span>Pending cashback</span><b>{money(wallet?.pendingCashback)}</b><small>Releases at month-end</small></article>
    <article className="wallet-metric"><span>This month&apos;s earnings</span><b>{money(wallet?.monthEarnings)}</b><small>From completed paid deliveries</small></article>
   </div>
   <p className="wallet-policy">30% of the final delivery price is added after payment is verified and the delivery is completed. Each five completed paid deliveries earn cashback of 10% of those five rider shares; cashback unlocks at month-end.</p>
   <div className="wallet-progress"><span>{completed%5}/5 deliveries toward the next cashback reward</span><small>{Number(wallet?.deliveriesToCashback||5)} more completed paid {Number(wallet?.deliveriesToCashback)===1?"delivery":"deliveries"} needed</small></div>
   <div className="wallet-account">
    <div className="wallet-account-detail"><Building2 size={19}/><div><b>Bank account</b>{account?<small>{account.bankName} · {account.accountName} · •••• {account.accountLast4}</small>:<small>Add a verified Paystack payout account to withdraw.</small>}</div></div>
    <button className="secondary" type="button" onClick={()=>void openAccountForm()}>{account?"Manage account":"Add account"}</button>
   </div>
   {accountForm&&<form className="form wallet-bank-form" onSubmit={saveAccount}>
    <label>Bank<select required value={bankCode} onChange={event=>setBankCode(event.target.value)}><option value="">Select a bank</option>{banks.map(bank=><option value={bank.code} key={bank.code}>{bank.name}</option>)}</select></label>
    <label>Account number<input required inputMode="numeric" autoComplete="off" minLength="10" maxLength="10" pattern="[0-9]{10}" value={accountNumber} onChange={event=>setAccountNumber(event.target.value.replace(/\D/g,"").slice(0,10))} placeholder="10-digit account number"/></label>
    <small>Paystack will verify the account name before saving. The full account number is never displayed after it is saved.</small>
    {bankError&&<p className="wallet-error" role="alert">{bankError}</p>}
    <div className="actions"><button className="primary" disabled={savingAccount||banks.length===0}>{savingAccount?"Verifying…":"Verify and save account"}</button><button className="secondary" type="button" onClick={()=>setAccountForm(false)}>Cancel</button></div>
   </form>}
   <form className="wallet-withdraw" onSubmit={withdraw}>
    <label>Withdrawal amount (NGN)<input type="number" min="0.01" step="0.01" max={wallet?.availableBalance||0} value={amount} onChange={event=>setAmount(event.target.value)} placeholder="Enter amount"/></label>
    <button className="primary" disabled={withdrawing||!account||Number(wallet?.availableBalance||0)<=0}><ArrowDownToLine size={16}/>{withdrawing?"Submitting…":"Withdraw to bank"}</button>
   </form>
   {!account&&<small className="wallet-note">Completed delivery earnings remain in your wallet until you add a bank account and choose to withdraw.</small>}
   <div className="wallet-history">
    <h3><Clock3 size={17}/> Recent wallet activity</h3>
    {entries.length===0&&withdrawals.length===0?<p className="wallet-note">Completed paid deliveries and withdrawal updates will appear here.</p>:<ul>{[
     ...entries.map(entry=>({...entry,kind:entry.entry_type})),
     ...withdrawals.map(item=>({...item,kind:"withdrawal",created_at:item.requested_at}))
    ].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,12).map((item,index)=><li key={`${item.kind}-${item.id||item.created_at}-${index}`}>
     <span><b>{item.kind==="delivery_earning"?"Completed delivery earning":item.kind==="cashback"?"Five-delivery cashback":`Withdrawal · ${statusLabel(item.status)}`}</b><small>{item.tracking_number||item.status_message||date(item.created_at)} · {date(item.created_at)}</small></span>
     <strong className={item.kind==="withdrawal"?"wallet-debit":""}>{item.kind==="withdrawal"?"−":"+"}{money(item.amount)}</strong>
    </li>)}</ul>}
   </div>
  </>}
 </section>;
}
