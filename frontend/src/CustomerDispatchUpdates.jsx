import React,{useEffect,useState} from "react";
import {Clock3} from "lucide-react";

const readable={
 payment_confirmed:"Payment confirmed",
 rider_accepted:"A rider accepted this delivery",
 quote_vehicle_reviewed:"Operations verified the delivery vehicle",
 admin_assigned_rider:"Operations assigned a rider",
 admin_returned_to_pool:"Operations returned this delivery to rider matching",
 rider_problem_reported:"The assigned rider reported a delivery problem. Operations is reviewing it.",
 status_changed:"Delivery progress updated",
 customer_confirmed:"Delivery confirmed",
 admin_cancelled:"Delivery cancelled by operations"
};

export default function CustomerDispatchUpdates({supabase,customerId,toast}){
 const [rows,setRows]=useState([]);
 useEffect(()=>{
  if(!supabase||!customerId){setRows([]);return}
  let active=true;
  const load=async()=>{
   const {data:orders,error:ordersError}=await supabase.from("orders").select("id,tracking_number,status,payment_status,rider_id,created_at").eq("customer_id",customerId).order("created_at",{ascending:false}).limit(50);
   if(!active)return;
   if(ordersError){toast(`Could not refresh customer dispatch updates: ${ordersError.message}`);return}
   if(!orders?.length){setRows([]);return}
   const ids=orders.map(order=>order.id);
   const {data:events,error}=await supabase.from("order_events").select("id,order_id,event,created_at").in("order_id",ids).order("created_at",{ascending:false}).limit(80);
   if(!active)return;
   if(error){toast(`Could not load delivery update history: ${error.message}`);return}
   const orderById=new Map(orders.map(order=>[order.id,order]));
   setRows((events||[]).filter(event=>readable[event.event]).map(event=>({...event,order:orderById.get(event.order_id)})));
  };
  load();
  const channel=supabase.channel(`customer-dispatch-updates-${customerId}`)
   .on("postgres_changes",{event:"*",schema:"public",table:"orders",filter:`customer_id=eq.${customerId}`},load)
   .on("postgres_changes",{event:"INSERT",schema:"public",table:"order_events"},load)
   .subscribe(status=>{if(status==="CHANNEL_ERROR")toast("Live dispatch notifications are unavailable. Updates will refresh periodically.")});
  const timer=setInterval(load,15000);
  return()=>{active=false;clearInterval(timer);supabase.removeChannel(channel)};
 },[supabase,customerId,toast]);
 if(!rows.length)return null;
 return <section className="panel dispatch-updates" aria-live="polite">
  <div className="panel-head"><div><span className="eyebrow">LIVE DELIVERY UPDATES</span><h2>Recent dispatch activity</h2></div><Clock3/></div>
  <div className="dispatch-event-list">{rows.slice(0,8).map(row=><article className="dispatch-event" key={row.id}>
   <div><b>{row.order?.tracking_number||"Delivery"}</b><span>{readable[row.event]}</span></div>
   <small>{row.order?.payment_status==="paid"&&row.order?.status==="paid"&&!row.order?.rider_id?"Waiting for a compatible rider":row.order?.status||"Order updated"} · {new Date(row.created_at).toLocaleString()}</small>
  </article>)}</div>
 </section>;
}