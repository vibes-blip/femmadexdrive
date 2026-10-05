import {sb,json,body,err,userFromRequest} from "./_lib.mjs";
import {reverseGeocode} from "./_geocoding.mjs";

const choose=(w,size,volume)=>w>250||size==="very_large"||volume>1000000?"lorry":w>50||size==="large"||volume>250000?"van":w>12||size==="medium"||volume>60000?"car":"motorcycle";
const prices={motorcycle:[Number(process.env.PRICE_BASE_MOTORCYCLE||1000),Number(process.env.PRICE_PER_KM_MOTORCYCLE||180)],car:[Number(process.env.PRICE_BASE_CAR||1800),Number(process.env.PRICE_PER_KM_CAR||250)],van:[Number(process.env.PRICE_BASE_VAN||3000),Number(process.env.PRICE_PER_KM_VAN||350)],lorry:[Number(process.env.PRICE_BASE_LORRY||6000),Number(process.env.PRICE_PER_KM_LORRY||500)]};

export default async req=>{
 if(req.method==="OPTIONS")return new Response("",{status:204});
 try{
  const user=await userFromRequest(req),b=await body(req);
  if(!b.description)throw new Error("Package description is required.");
  const recipientName=String(b.recipientName||"").trim().slice(0,120);
  if(!recipientName)throw new Error("Recipient name is required.");
  if(!b.pickupCoordinates||!b.dropoffCoordinates)throw new Error("Select both pickup and destination locations from the address results or map.");
  const [pickup,dropoff]=await Promise.all([
   reverseGeocode(Number(b.pickupCoordinates.lat),Number(b.pickupCoordinates.lng)),
   reverseGeocode(Number(b.dropoffCoordinates.lat),Number(b.dropoffCoordinates.lng))
  ]);
  if(!process.env.ORS_API_KEY)throw new Error("ORS_API_KEY is not configured.");
  const routeResponse=await fetch("https://api.openrouteservice.org/v2/directions/driving-car",{
   method:"POST",
   headers:{"Authorization":process.env.ORS_API_KEY,"Content-Type":"application/json"},
   body:JSON.stringify({coordinates:[[pickup.lng,pickup.lat],[dropoff.lng,dropoff.lat]],instructions:false})
  });
  if(!routeResponse.ok)throw new Error("No drivable route found.");
  const route=await routeResponse.json(),summary=route.routes?.[0]?.summary;
  if(!summary)throw new Error("No drivable route found.");
  const distanceKm=Number((summary.distance/1000).toFixed(1)),durationMinutes=Math.max(1,Math.round(summary.duration/60));
  const weight=Number(b.weight)||0,volume=(Number(b.length)||0)*(Number(b.width)||0)*(Number(b.height)||0);
  const size=b.size||"medium",vehicleType=choose(weight,size,volume),[base,perKm]=prices[vehicleType];
  let price=Math.ceil((base+distanceKm*perKm)/100)*100;
  if(weight>100)price+=Math.ceil((weight-100)*10/100)*100;
  const db=sb();
  const {data:order,error}=await db.from("orders").insert({
   customer_id:user.id,
   pickup_address:pickup.address,
   pickup_latitude:pickup.lat,
   pickup_longitude:pickup.lng,
   dropoff_address:dropoff.address,
   dropoff_latitude:dropoff.lat,
   dropoff_longitude:dropoff.lng,
   recipient_name:recipientName,
   recipient_phone:String(b.recipientPhone||"").trim().slice(0,40)||null,
   goods_description:String(b.description).trim(),
   weight_kg:weight||null,
   length_cm:Number(b.length)||null,
   width_cm:Number(b.width)||null,
   height_cm:Number(b.height)||null,
   package_size:size,
   vehicle_type:vehicleType,
   distance_km:distanceKm,
   duration_minutes:durationMinutes,
   system_price:price,
   final_price:price,
   status:"price_review",
   payment_status:"unpaid"
  }).select("*").single();
  if(error)throw error;
  await db.from("order_events").insert({order_id:order.id,actor_id:user.id,event:"delivery_created",note:"Server-calculated road route and selected pickup/dropoff coordinates"});
  return json({order});
 }catch(e){return err(e)}
};
