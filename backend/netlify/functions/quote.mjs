import {json,body,err} from "./_lib.mjs";
import {reverseGeocode} from "./_geocoding.mjs";

const vehicle=(w,size,volume)=>{if(w>250||size==="very_large"||volume>1000000)return"lorry";if(w>50||size==="large"||volume>250000)return"van";if(w>12||size==="medium"||volume>60000)return"car";return"motorcycle"};
const prices={motorcycle:[Number(process.env.PRICE_BASE_MOTORCYCLE||1000),Number(process.env.PRICE_PER_KM_MOTORCYCLE||180)],car:[Number(process.env.PRICE_BASE_CAR||1800),Number(process.env.PRICE_PER_KM_CAR||250)],van:[Number(process.env.PRICE_BASE_VAN||3000),Number(process.env.PRICE_PER_KM_VAN||350)],lorry:[Number(process.env.PRICE_BASE_LORRY||6000),Number(process.env.PRICE_PER_KM_LORRY||500)]};
const validCoordinate=value=>value!==null&&value!==undefined&&value!==""&&Number.isFinite(Number(value));


export default async req=>{
 if(req.method==="OPTIONS")return new Response("",{status:204});
 try{
  const b=await body(req);
  if(!b.pickupCoordinates||!b.dropoffCoordinates||!validCoordinate(b.pickupCoordinates.lat)||!validCoordinate(b.pickupCoordinates.lng)||!validCoordinate(b.dropoffCoordinates.lat)||!validCoordinate(b.dropoffCoordinates.lng))throw new Error("Select both pickup and destination locations from the address results or map.");

  const [pickup,dropoff]=await Promise.all([
   reverseGeocode(Number(b.pickupCoordinates.lat),Number(b.pickupCoordinates.lng)),
   reverseGeocode(Number(b.dropoffCoordinates.lat),Number(b.dropoffCoordinates.lng))
  ]);
  if(!process.env.ORS_API_KEY)throw new Error("ORS_API_KEY is not configured yet.");
  const routeResponse=await fetch("https://api.openrouteservice.org/v2/directions/driving-car",{
   method:"POST",
   headers:{"Authorization":process.env.ORS_API_KEY,"Content-Type":"application/json"},
   body:JSON.stringify({coordinates:[[pickup.lng,pickup.lat],[dropoff.lng,dropoff.lat]],instructions:false})
  });
  if(!routeResponse.ok)throw new Error("Road routing service could not calculate this route.");
  const route=await routeResponse.json(),summary=route.routes?.[0]?.summary;
  if(!summary)throw new Error("No drivable route was found.");
  const distanceKm=Number((summary.distance/1000).toFixed(1)),durationMinutes=Math.max(1,Math.round(summary.duration/60));
  const volume=(Number(b.lengthCm)||0)*(Number(b.widthCm)||0)*(Number(b.heightCm)||0),weight=Number(b.weightKg)||0;
  const vehicleType=vehicle(weight,b.size,volume),[base,perKm]=prices[vehicleType];
  let price=Math.ceil((base+distanceKm*perKm)/100)*100;
  if(weight>100)price+=Math.ceil((weight-100)*10/100)*100;
  return json({pickup,dropoff,distanceKm,durationMinutes,vehicleType,price,currency:"NGN"});
 }catch(e){return err(e)}
};
