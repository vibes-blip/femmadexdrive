import React,{useEffect,useMemo,useRef,useState} from "react";
import {AlertTriangle,Check,Clock3,Phone,RefreshCw,ShieldAlert} from "lucide-react";

const terminal=new Set(["completed","cancelled"]);
const normalized=value=>String(value||"").trim().toLowerCase();
const compatible=(rider,order)=>{
 const riderVehicle=normalized(rider),orderVehicle=normalized(order);
 if(["bike","motorcycle"].includes(orderVehicle))return ["bike","motorcycle"].includes(riderVehicle);
 if(orderVehicle==="car"||orderVehicle==="van")return riderVehicle===orderVehicle;
 if(["truck","lorry"].includes(orderVehicle))return ["truck","lorry"].includes(riderVehicle);
 return false;
};
const stamp=value=>value?new Date(value).toLocaleString():"";

export default function AdminDispatchControls({supabase,session,profile,orders,riders,selected,toast,refresh,notifyAdmin}){
 const [alerts,setAlerts]=useState([]),[offers,setOffers]=useState([]),[events,setEvents]=useState([]),[history,setHistory]=useState([]),[riderAudit,setRiderAudit]=useState([]),[contacts,setContacts]=useState(null);
 const [manualRider,setManualRider]=useState(""),[reason,setReason]=useState(""),[cancelReason,setCancelReason]=useState(""),[handover,setHandover]=useState(""),[handoverConfirmed,setHandoverConfirmed]=useState(false),[busy,setBusy]=useState(false);
 const notifiedAlerts=useRef(new Set());
 const authorised=["admin","supervisor"].includes(profile?.role);
 const activeRiders=useMemo(()=>new Set(orders.filter(order=>order.rider_id&&!terminal.has(order.status)).map(order=>order.rider_id)),[orders]);
 const eligibleRiders=useMemo(()=>{
  if(!selected||selected.rider_id||selected.payment_status!=="paid")return [];
  const declined=new Set(offers.filter(offer=>offer.order_id===selected.id&&offer.status==="declined").map(offer=>offer.rider_id));
  return riders.filter(rider=>rider.approval_status==="approved"&&rider.is_online&&!activeRiders.has(rider.id)&&compatible(rider.vehicle_type,selected.vehicle_type)&&!declined.has(rider.id));
 },[selected,riders,activeRiders,offers]);
 const needsHandover=["picked_up","on_the_way","at_door"].includes(selected?.status);

 const load=async()=>{
  if(!authorised||!supabase)return;
  const {error:refreshError}=await supabase.rpc("refresh_admin_dispatch_queue");
  if(refreshError){toast(`Could not refresh rider dispatch queue: ${refreshError.message}`);return}
  const [alertResult,offerResult,eventResult,historyResult,riderAuditResult]=await Promise.all([
   supabase.from("dispatch_alerts").select("*").is("resolved_at",null).is("acknowledged_at",null).order("created_at",{ascending:false}).limit(100),
   supabase.from("rider_offers").select("*").order("offered_at",{ascending:false}).limit(300),
   supabase.from("order_events").select("id,order_id,actor_id,event,note,created_at").order("created_at",{ascending:false}).limit(100),
   supabase.from("order_assignment_history").select("*").order("created_at",{ascending:false}).limit(100),
   supabase.from("rider_admin_events").select("*").order("created_at",{ascending:false}).limit(100)
  ]);
  for(const [label,result] of [["dispatch alerts",alertResult],["rider offers",offerResult],["delivery activity",eventResult],["assignment history",historyResult],["rider approval history",riderAuditResult]]){
   if(result.error){toast(`Could not load ${label}: ${result.error.message}`);return}
  }
  const newAlerts=alertResult.data||[];
  setAlerts(newAlerts);setOffers(offerResult.data||[]);setEvents(eventResult.data||[]);setHistory(historyResult.data||[]);setRiderAudit(riderAuditResult.data||[]);
  for(const alert of newAlerts)if(!notifiedAlerts.current.has(alert.id)){
   notifiedAlerts.current.add(alert.id);
   notifyAdmin(alert.id).catch(error=>toast(`Live dispatch alert is available, but admin email notification failed: ${error.message}`));
  }
 };

 useEffect(()=>{
  if(!authorised||!session||!supabase)return;
  load();
  const channel=supabase.channel(`admin-dispatch-controls-${session.user.id}`)
   .on("postgres_changes",{event:"*",schema:"public",table:"orders"},load)
   .on("postgres_changes",{event:"*",schema:"public",table:"riders"},load)
   .on("postgres_changes",{event:"*",schema:"public",table:"rider_offers"},load)
   .on("postgres_changes",{event:"*",schema:"public",table:"dispatch_alerts"},load)
   .on("postgres_changes",{event:"INSERT",schema:"public",table:"order_events"},load)
   .on("postgres_changes",{event:"INSERT",schema:"public",table:"order_assignment_history"},load)
   .on("postgres_changes",{event:"INSERT",schema:"public",table:"rider_admin_events"},load)
   .subscribe(status=>{if(status==="CHANNEL_ERROR")toast("Live dispatch alerts are unavailable. The refresh button remains available.")});
  const timer=setInterval(load,15000);
  return()=>{clearInterval(timer);supabase.removeChannel(channel)};
 },[authorised,session?.user?.id]);

 useEffect(()=>{
  if(!authorised||!selected||!session)return;
  let active=true;
  supabase.rpc("get_delivery_contacts",{p_order_id:selected.id}).then(({data,error})=>{
   if(!active)return;
   if(error){toast(`Could not load authorised delivery contact details: ${error.message}`);return}
   setContacts(data?.[0]||null);
  });
  return()=>{active=false;setContacts(null)};
 },[authorised,selected?.id,session?.user?.id]);

 useEffect(()=>{
  if(eligibleRiders.some(rider=>rider.id===manualRider))return;
  setManualRider(eligibleRiders[0]?.id||"");
 },[eligibleRiders,manualRider]);

 if(!authorised)return null;
 const orderName=id=>orders.find(order=>order.id===id)?.tracking_number||id;
 const riderName=id=>riders.find(rider=>rider.id===id)?.display_name;
 const run=async(rpc,args,success)=>{
  setBusy(true);
  try{
   const {error}=await supabase.rpc(rpc,args);
   if(error)throw error;
   toast(success);setReason("");setHandover("");setHandoverConfirmed(false);
   await Promise.all([refresh(),load()]);
  }catch(error){toast(error.message||"Operations action failed")}
  finally{setBusy(false)}
 };
 const assign=()=>run("admin_assign_order",{p_order_id:selected.id,p_rider_id:manualRider,p_reason:reason},"Rider assigned and delivery history recorded.");
 const release=()=>run("return_order_to_rider_pool",{p_order_id:selected.id,p_reason:reason,p_handover_confirmed:handoverConfirmed,p_handover_details:handover||null},"Delivery returned to rider matching and compatible riders notified.");
 const cancel=()=>{if(window.confirm(`Cancel ${selected.tracking_number}? The payment status will not be changed.`))run("admin_cancel_order",{p_order_id:selected.id,p_reason:cancelReason,p_handover_confirmed:handoverConfirmed,p_handover_details:handover||null},"Delivery cancelled and the action recorded.");};
 const setRiderStatus=(id,status)=>run("set_rider_approval_status",{p_rider_id:id,p_status:status},`Rider status changed to ${status}.`);
 const resolveAlert=id=>run("acknowledge_dispatch_alert",{p_alert_id:id},"Dispatch alert acknowledged.");

 return <section className="panel admin-dispatch">
  <div className="panel-head"><div><span className="eyebrow">LIVE DISPATCH CONTROL</span><h2>Matching alerts and interventions</h2></div><button className="secondary" onClick={()=>{refresh();load()}}><RefreshCw size={15}/> Refresh</button></div>
  <div className="metrics">
   <div className="metric"><b>{orders.filter(order=>order.payment_status==="paid"&&!order.rider_id&&!terminal.has(order.status)).length}</b><span>Paid and awaiting rider</span></div>
   <div className="metric"><b>{orders.filter(order=>order.rider_id&&!terminal.has(order.status)).length}</b><span>Assigned and active</span></div>
   <div className="metric"><b>{alerts.filter(alert=>["no_compatible_rider","all_offers_exhausted"].includes(alert.alert_type)).length}</b><span>No rider / offers exhausted</span></div>
   <div className="metric"><b>{alerts.filter(alert=>["rider_problem","reassignment_required","unassigned_overdue"].includes(alert.alert_type)).length}</b><span>Needs intervention</span></div>
  </div>
  <h3>Open admin notifications</h3>
  {!alerts.length?<p className="address-hint">No open dispatch alerts.</p>:<div className="dispatch-event-list">{alerts.map(alert=><article className="dispatch-event" key={alert.id}>
   <div><b>{orderName(alert.order_id)} · {alert.alert_type.replaceAll("_"," ")}</b><span>{alert.details}</span></div>
   <small>{stamp(alert.created_at)}</small>
   <button className="secondary" disabled={busy} onClick={()=>resolveAlert(alert.id)}><Check size={15}/> Acknowledge</button>
  </article>)}</div>}

  <h3>Rider status and approval</h3>
  <div className="dispatch-event-list">{riders.map(rider=>{
   const assignment=orders.find(order=>order.rider_id===rider.id&&!terminal.has(order.status));
   const label=assignment?`Assigned · ${assignment.tracking_number}`:rider.approval_status==="suspended"?"Suspended":rider.approval_status==="approved"?(rider.is_online?"Online and available":"Offline"):rider.approval_status;
   return <article className="dispatch-event" key={rider.id}>
    <div><b>{rider.display_name}</b><span>{rider.vehicle_type||"Vehicle not registered"} · {label}</span></div>
    <div className="actions">
     {["suspended","rejected"].includes(rider.approval_status)&&<button className="primary" disabled={busy||!!assignment} onClick={()=>setRiderStatus(rider.id,"approved")}>Approve / reinstate</button>}
     {rider.approval_status==="approved"&&<button className="secondary" disabled={busy||!!assignment} title={assignment?"Return or reassign the active delivery first":""} onClick={()=>setRiderStatus(rider.id,"suspended")}><ShieldAlert size={15}/> Suspend</button>}
    </div>
   </article>;
  })}</div>
  <div className="dispatch-event-list">{riderAudit.slice(0,10).map(entry=><article className="dispatch-event" key={entry.id}>
   <div><b>{riders.find(rider=>rider.id===entry.rider_id)?.display_name||"Rider"} · {entry.event.replaceAll("_"," ")}</b><span>{entry.details}</span></div>
   <small>{stamp(entry.created_at)}</small>
  </article>)}</div>

  {selected&&<div className="dispatch-selected">
   <h3>{selected.tracking_number} · {selected.status}</h3>
   <p><b>Assigned rider:</b> {selected.rider?.display_name||"No rider assigned"}</p>
   {contacts&&<div className="contact-actions">
    {contacts.customer_phone&&<a className="secondary" href={`tel:${contacts.customer_phone}`}><Phone size={15}/> Contact customer</a>}
    {contacts.rider_phone&&<a className="primary" href={`tel:${contacts.rider_phone}`}><Phone size={15}/> Contact rider</a>}
    {!contacts.customer_phone&&!contacts.rider_phone&&<small>Authorised phone details are not available.</small>}
   </div>}
   {selected.payment_status==="paid"&&!selected.rider_id&&["paid","searching"].includes(selected.status)&&<div className="form">
    <label>Manual assignment reason<input maxLength="1000" value={reason} onChange={event=>setReason(event.target.value)} required/></label>
    <label>Eligible online rider<select value={manualRider} onChange={event=>setManualRider(event.target.value)}><option value="">Select a rider</option>{eligibleRiders.map(rider=><option key={rider.id} value={rider.id}>{rider.display_name} · {rider.vehicle_type}</option>)}</select></label>
    <button className="primary" disabled={busy||!manualRider||reason.trim().length<3} onClick={assign}>Assign rider</button>
    {!eligibleRiders.length&&<small>No online, approved, compatible, unassigned rider is available.</small>}
   </div>}
   {selected.rider_id&&["accepted","picked_up","on_the_way","at_door"].includes(selected.status)&&<div className="form">
    <label>Reassignment reason<input maxLength="1000" value={reason} onChange={event=>setReason(event.target.value)} required/></label>
    {needsHandover&&<>
     <label className="check"><input type="checkbox" checked={handoverConfirmed} onChange={event=>setHandoverConfirmed(event.target.checked)}/> I confirmed package custody and recovery/handover arrangements with the rider/customer.</label>
     <label>Handover or recovery arrangements<textarea maxLength="2000" value={handover} onChange={event=>setHandover(event.target.value)} required/></label>
    </>}
    <button className="secondary" disabled={busy||reason.trim().length<3||(needsHandover&&(!handoverConfirmed||handover.trim().length<5))} onClick={release}>Safely remove assignment and return to pool</button>
    {needsHandover&&<small><AlertTriangle size={14}/> Reassignment stays blocked until custody and recovery details are confirmed.</small>}
   </div>}
   {!terminal.has(selected.status)&&selected.status!=="delivered"&&<div className="form">
    <label>Cancellation reason<input maxLength="1000" value={cancelReason} onChange={event=>setCancelReason(event.target.value)} required/></label>
    <button className="secondary" disabled={busy||cancelReason.trim().length<3||(needsHandover&&(!handoverConfirmed||handover.trim().length<5))} onClick={cancel}>Cancel delivery with audit reason</button>
   </div>}
  </div>}

  <h3>Recent rider responses and delivery problems</h3>
  <div className="dispatch-event-list">{events.filter(event=>["rider_declined","rider_offer_timed_out","rider_problem_reported","admin_returned_to_pool","admin_assigned_rider","admin_cancelled"].includes(event.event)).slice(0,20).map(event=><article className="dispatch-event" key={event.id}>
   <div><b>{orderName(event.order_id)} · {event.event.replaceAll("_"," ")}</b><span>{riderName(event.actor_id)?`${riderName(event.actor_id)} · `:""}{event.note||"No reason supplied."}</span></div>
   <small>{stamp(event.created_at)}</small>
  </article>)}</div>

  <h3>Reassignment and assignment history</h3>
  <div className="dispatch-event-list">{history.slice(0,20).map(entry=><article className="dispatch-event" key={entry.id}>
   <div><b>{orderName(entry.order_id)} · {entry.action.replaceAll("_"," ")}</b><span>{riderName(entry.previous_rider_id)||"Unassigned"} → {riderName(entry.new_rider_id)||"Rider pool"} · {entry.reason}{entry.handover_details?` · Handover: ${entry.handover_details}`:""}</span></div>
   <small>{stamp(entry.created_at)}</small>
  </article>)}</div>
  {!history.length&&<small><Clock3 size={14}/> No assignment changes recorded yet.</small>}
 </section>;
}