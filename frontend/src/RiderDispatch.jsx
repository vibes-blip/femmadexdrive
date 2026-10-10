import React, {useState} from "react";
import {AlertTriangle, Clock3, Package} from "lucide-react";

const money=value=>`₦${Number(value||0).toLocaleString()}`;
const expires=value=>value?new Date(value).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):"";
const categoryLabel=offer=>offer.package_category==="small"?"Small package":offer.package_category==="bulky"||["large","very_large"].includes(offer.package_size)?"Large or bulky package":"Medium package";

export default function RiderDispatch({offers,hasActiveDispatch,acceptingOrderId,onAccept,onDecline}){
 const [reasons,setReasons]=useState({});
 if(!offers.length)return <div className="empty"><Package size={18}/>No eligible paid delivery is waiting right now. Offers refresh automatically.</div>;
 return <div className="dispatch-offers">
  {offers.map(offer=><article className="job" key={offer.id}>
   <div className="order-top"><b>{offer.tracking_number}</b><strong>{offer.vehicle_type} · {money(offer.final_price)}</strong></div>
   <p>Pickup and recipient details are available after you accept the delivery.</p>
   <p><Package/> <b>{categoryLabel(offer)}</b> · {offer.goods_description}{offer.weight_kg?` · ${offer.weight_kg} kg`:""}</p>
   <small>{offer.distance_km||"—"} km · {offer.duration_minutes||"—"} min</small>
   <small className="address-hint"><Clock3 size={14}/> Offer expires {expires(offer.offer_expires_at)}</small>
   <label>Decline reason (optional)<input maxLength="1000" value={reasons[offer.id]||""} onChange={event=>setReasons(current=>({...current,[offer.id]:event.target.value}))}/></label>
   <div className="actions">
    <button className="primary" disabled={hasActiveDispatch||acceptingOrderId!==null} onClick={()=>onAccept(offer)}>{acceptingOrderId===offer.id?"Accepting…":"Accept delivery"}</button>
    <button className="secondary" disabled={acceptingOrderId===offer.id} onClick={()=>onDecline(offer,reasons[offer.id]||"")}>Decline</button>
   </div>
   {hasActiveDispatch&&<small><AlertTriangle size={14}/> Finish your assigned delivery before accepting another.</small>}
  </article>)}
 </div>;
}