import React,{useEffect,useState} from "react";
import {Check,RefreshCw,Ticket,X} from "lucide-react";

const money=value=>`₦${Number(value||0).toLocaleString()}`;
const date=value=>value?new Date(value).toLocaleDateString():"—";
const previousMonth=()=>{
 const value=new Date();
 value.setDate(1);
 value.setMonth(value.getMonth()-1);
 return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,"0")}-01`;
};

export default function CouponAdmin({supabase,session,profile,toast}){
 const [records,setRecords]=useState([]),[issuedCoupons,setIssuedCoupons]=useState([]),[program,setProgram]=useState("month"),[period,setPeriod]=useState(previousMonth());
 const [candidates,setCandidates]=useState([]),[issued,setIssued]=useState([]),[loading,setLoading]=useState(false);
 const authorised=["admin","supervisor"].includes(profile?.role);
 const load=async()=>{
  if(!authorised)return;
  setLoading(true);
  try{
   const [claimsResult,couponsResult]=await Promise.all([
    supabase.rpc("get_admin_delivery_coupon_records"),
    supabase.from("delivery_coupons").select("id,code,program,discount_percent,customer_id,expires_at,active,created_at").order("created_at",{ascending:false}).limit(200)
   ]);
   if(claimsResult.error)throw claimsResult.error;
   if(couponsResult.error)throw couponsResult.error;
   const coupons=couponsResult.data||[];
   const customerIds=[...new Set(coupons.map(coupon=>coupon.customer_id).filter(Boolean))];
   const owners=customerIds.length?await supabase.from("profiles").select("id,full_name,email").in("id",customerIds):{data:[],error:null};
   if(owners.error)throw owners.error;
   const ownerById=new Map((owners.data||[]).map(owner=>[owner.id,owner]));
   setRecords(claimsResult.data||[]);
   setIssuedCoupons(coupons.map(coupon=>({...coupon,customer:ownerById.get(coupon.customer_id)})));
  }catch(error){toast(`Could not load coupon records: ${error.message}`)}
  finally{setLoading(false)}
 };
 useEffect(()=>{void load()},[authorised,session?.user?.id]);
 const getCandidates=async event=>{
  event.preventDefault();
  setLoading(true);setCandidates([]);setIssued([]);
  try{
   const {data,error}=await supabase.rpc("get_delivery_coupon_award_candidates",{p_program:program,p_period_start:period});
   if(error)throw error;
   setCandidates(data||[]);
  }catch(error){toast(`Could not calculate coupon award candidates: ${error.message}`)}
  finally{setLoading(false)}
 };
 const award=async()=>{
  if(!candidates.length||!window.confirm(`Issue a 30-day ${program==="month"?"30% monthly":"25% yearly"} coupon to the top ${candidates.length} customers for this period?`))return;
  setLoading(true);
  try{
   const {data,error}=await supabase.rpc("award_delivery_coupons",{p_program:program,p_period_start:period});
   if(error)throw error;
   setIssued(data||[]);
   await load();
   toast("Coupon awards issued. Copy each customer-specific code into the customer notification.");
  }catch(error){toast(`Could not issue coupon awards: ${error.message}`)}
  finally{setLoading(false)}
 };
 const review=async(record,approve)=>{
  setLoading(true);
  try{
   const {error}=await supabase.rpc("review_delivery_coupon_claim",{p_claim_id:record.claim_id,p_approve:approve});
   if(error)throw error;
   toast(approve?"Coupon approved; its discount is reflected in the customer’s payable price.":"Coupon declined; the original approved price remains due.");
   await load();
  }catch(error){toast(`Could not review coupon: ${error.message}`)}
  finally{setLoading(false)}
 };
 if(!authorised)return null;
 return <main className="page coupon-admin-page">
  <section className="panel">
   <div className="panel-head"><div><span className="eyebrow">CUSTOMER SAVINGS</span><h2>Coupon awards</h2></div><Ticket/></div>
   <p>Rank completed, paid deliveries by total spend, then completed delivery count, then route distance. Review the top three before issuing customer-specific codes valid for 30 days.</p>
   <form className="coupon-award-form" onSubmit={getCandidates}>
    <label>Award<select value={program} onChange={event=>{setProgram(event.target.value);setCandidates([]);setIssued([])}}><option value="month">Customer of the month · 30% off</option><option value="year">Customer of the year · 25% off</option></select></label>
    <label>{program==="month"?"Completed month":"Completed year"}<input type={program==="month"?"month":"number"} min={program==="year"?2010:undefined} max={program==="year"?new Date().getFullYear()-1:undefined} value={program==="year"?period.slice(0,4):period.slice(0,7)} onChange={event=>setPeriod(program==="year"?`${event.target.value}-01-01`:`${event.target.value}-01`)}/></label>
    <button className="secondary" disabled={loading}>Calculate top three</button>
   </form>
   {candidates.length>0&&<><div className="coupon-record-list">{candidates.map((candidate,index)=><article className="coupon-record" key={candidate.customer_id}><b>#{index+1} · {candidate.customer_name||candidate.customer_email}</b><small>{candidate.customer_email||"No email"} · Spend {money(candidate.total_spend)} · {candidate.completed_deliveries} completed · {(Number(candidate.total_distance_meters||0)/1000).toFixed(1)} km</small></article>)}</div><button className="primary" onClick={award} disabled={loading}>Approve ranking and issue coupons</button></>}
   {issued.length>0&&<div className="coupon-record-list" aria-live="polite">{issued.map(item=><article className="coupon-record" key={item.code}><b>{item.customer_name||item.customer_email} · {item.code}</b><small>{item.discount_percent}% off · expires {date(item.expires_at)} · Send this code to the customer.</small></article>)}</div>}
  </section>
  <section className="panel">
   <div className="panel-head"><h2>Issued coupon codes</h2><span>{issuedCoupons.length} codes</span></div>
   {issuedCoupons.length===0?<p>No coupon codes have been issued.</p>:<div className="coupon-record-list">{issuedCoupons.map(coupon=><article className="coupon-record" key={coupon.id}><b>{coupon.code} · {coupon.discount_percent}% · {coupon.program.replaceAll("_"," ")}</b><small>{coupon.customer?.full_name||coupon.customer?.email||"Public code"} · {coupon.customer?.email||""} · {coupon.active?"Active":"Inactive"} · expires {date(coupon.expires_at)}</small></article>)}</div>}
  </section>
  <section className="panel">
   <div className="panel-head"><div><span className="eyebrow">PROMO AUDIT</span><h2>Coupon requests & savings</h2></div><button className="secondary" onClick={()=>void load()} disabled={loading}><RefreshCw size={16}/> Refresh</button></div>
   <p>Church and Unilag claims require manual eligibility approval. Redemption amounts are recorded after successful payment.</p>
   {records.length===0?<p>{loading?"Loading coupon records…":"No coupon requests or redemptions yet."}</p>:<div className="coupon-record-list">{records.map(record=><article className="coupon-record" key={record.claim_id}>
    <div className="coupon-record-heading"><b>{record.code} · {record.discount_percent}%</b><strong>{record.status.replaceAll("_"," ")}</strong></div>
    <small>{record.customer_name||record.customer_email||record.customer_id} · {record.customer_email||"No email"} · {record.tracking_number||"Quote not linked"} · {date(record.created_at)}</small>
    {record.original_price!==null&&<small>Original {money(record.original_price)} · Discount {money(record.discount_amount)} · Customer pays {money(record.payable_amount)}</small>}
    {record.status==="pending_admin_approval"&&<div className="actions"><button className="primary" disabled={loading} onClick={()=>void review(record,true)}><Check size={15}/> Approve code</button><button className="secondary" disabled={loading} onClick={()=>void review(record,false)}><X size={15}/> Decline</button></div>}
   </article>)}</div>}
  </section>
 </main>;
}
