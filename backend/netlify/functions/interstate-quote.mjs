import {sb,json,body,err,userFromRequest,HttpError} from "./_lib.mjs";
import {reverseGeocode} from "./_geocoding.mjs";
import {resolvePackageSelection} from "./_package-selection.mjs";
import {calculateInterstatePrice} from "./_interstate-pricing.mjs";

const ORS_DIRECTIONS_URL="https://api.openrouteservice.org/v2/directions/driving-car/geojson";
const DISPATCH_TERMS_VERSION="dispatch-terms-2026-10-12";
const coordinate=(point,key,min,max)=>{
 const value=point?.[key];
 if(value===null||value===undefined||value==="")return null;
 if(typeof value!=="number"&&typeof value!=="string")return null;
 if(typeof value==="string"&&!value.trim())return null;
 const number=Number(value);
 return Number.isFinite(number)&&number>=min&&number<=max?number:null;
};
const withinLimit=(value,limit)=>value===null||limit===null||limit===undefined||Number(value)<=Number(limit);

async function routeLeg(from,to){
 if(!process.env.ORS_API_KEY)throw new HttpError("Interstate road routing is not configured. Please contact FemmaDexDrive support.",503);
 let response;
 try{
  response=await fetch(ORS_DIRECTIONS_URL,{
   method:"POST",
   headers:{"Authorization":process.env.ORS_API_KEY,"Content-Type":"application/json"},
   body:JSON.stringify({coordinates:[[from.longitude,from.latitude],[to.longitude,to.latitude]],instructions:false}),
   signal:AbortSignal.timeout(12000)
  });
 }catch(error){
  console.error("OpenRouteService interstate route request failed",error.message);
  throw new HttpError("Unable to calculate the station delivery route. Please try again.",502);
 }
 if(!response.ok){
  console.error("OpenRouteService rejected an interstate route leg",{status:response.status});
  throw new HttpError("Unable to calculate the station delivery route. Please try again.",502);
 }
 let summary;
 try{summary=(await response.json()).features?.[0]?.properties?.summary}
 catch(error){
  console.error("OpenRouteService returned invalid interstate route JSON",error.message);
  throw new HttpError("Unable to calculate the station delivery route. Please try again.",502);
 }
 if(!Number.isFinite(summary?.distance)||summary.distance<0||!Number.isFinite(summary?.duration)||summary.duration<0){
  throw new HttpError("A complete road route to the approved stations could not be calculated.",422);
 }
 return {distanceMeters:summary.distance,durationSeconds:summary.duration};
}

function operatingDelayDays(route,now=new Date()){
 const operatingDays=Array.isArray(route.operating_days)?route.operating_days:[];
 if(!operatingDays.length)return 0;
 const parts=new Intl.DateTimeFormat("en-GB",{
  timeZone:"Africa/Lagos",weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"
 }).formatToParts(now);
 const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));
 const weekdayNumber={Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6,Sun:7}[values.weekday];
 const localMinutes=Number(values.hour)*60+Number(values.minute);
 const cutoff=route.departure_cutoff||route.origin_station?.cutoff_time;
 const [cutoffHour,cutoffMinute]=String(cutoff||"23:59").split(":").map(Number);
 const afterCutoff=localMinutes>cutoffHour*60+cutoffMinute;
 for(let offset=0;offset<=7;offset++){
  const day=((weekdayNumber-1+offset)%7)+1;
  if(operatingDays.includes(day)&&!(offset===0&&afterCutoff))return offset;
 }
 return 7;
}

export default async request=>{
 if(request.method==="OPTIONS")return new Response("",{status:204});
 try{
  const user=await userFromRequest(request);
  const input=await body(request);
  if(!input||typeof input!=="object"||Array.isArray(input))throw new HttpError("Invalid interstate quote request.",400);
  if(input.termsAccepted!==true||input.termsVersion!==DISPATCH_TERMS_VERSION){
   throw new HttpError("Review and accept the current dispatch terms before requesting a quote.",400);
  }
  if(!/^[0-9a-f-]{36}$/i.test(String(input.routeId||""))||
    !/^[0-9a-f-]{36}$/i.test(String(input.destinationStationId||""))) {
   throw new HttpError("Choose an active station route and delivery service.",400);
  }
  if(typeof input.pickupState!=="string"||input.pickupState.trim().length<2||input.pickupState.length>80||
    typeof input.destinationState!=="string"||input.destinationState.trim().length<2||input.destinationState.length>80||
    typeof input.destinationCity!=="string"||input.destinationCity.trim().length<2||input.destinationCity.length>100) {
   throw new HttpError("Select the sender's pickup state and a supported destination state and city.",400);
  }
  if(!["small","medium","bulky"].includes(input.packageCategory)||!["standard","express"].includes(input.serviceTier)){
   throw new HttpError("Select a supported interstate package and service.",400);
  }
  const db=sb();
  const {data:profile,error:profileError}=await db.from("profiles").select("role,email").eq("id",user.id).maybeSingle();
  if(profileError)throw new HttpError("Your account could not be verified. Please try again.",503);
  if(profile?.role!=="customer")throw new HttpError("A customer account is required to request an interstate quote.",403);
  if(!user.email&&!profile?.email){
   const email=String(input.customerEmail||"").trim().toLowerCase();
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254){
    throw new HttpError("Enter a valid email address so FemmaDexDrive can send your booking updates.",400);
   }
   const {error:emailError}=await db.from("profiles").update({email}).eq("id",user.id);
   if(emailError)throw new HttpError("Could not save your contact email. Please try again.",503);
  }

  const {data:route,error:routeError}=await db.from("delivery_routes").select("*")
   .eq("id",input.routeId).eq("active",true).maybeSingle();
  if(routeError)throw new HttpError("The selected station route could not be verified.",503);
  const routeVerifiedAt=route?.last_verified_at?Date.parse(route.last_verified_at):NaN;
  if(!route||!Number.isFinite(routeVerifiedAt)||Date.now()-routeVerifiedAt<0||
    Date.now()-routeVerifiedAt>90*24*60*60*1000){
   throw new HttpError("The selected route is inactive or needs Operations re-verification.",409);
  }
  const {data:stations,error:stationError}=await db.from("delivery_stations").select("*")
   .in("id",[route.origin_station_id,route.destination_station_id]);
  if(stationError)throw new HttpError("The selected stations could not be verified.",503);
  const stationById=new Map((stations||[]).map(station=>[station.id,station]));
  const origin=stationById.get(route.origin_station_id),destination=stationById.get(route.destination_station_id);
  const stationIsReady=station=>station&&station.active&&station.operational_status==="operational";
  if(!stationIsReady(origin)||!stationIsReady(destination)||
    !origin.accepts_outgoing||!destination.accepts_incoming||
    String(origin.state).toLowerCase()!==input.pickupState.trim().toLowerCase()||
    String(destination.state).toLowerCase()!==input.destinationState.trim().toLowerCase()||
    String(destination.city).toLowerCase()!==input.destinationCity.trim().toLowerCase()) {
   throw new HttpError("The selected route no longer serves those states and city.",409);
  }
  if(input.serviceTier==="express"&&(!route.express_available||!Number.isInteger(route.express_max_days)||route.express_max_days>4)){
   throw new HttpError("Express service is unavailable for the selected route.",409);
  }

  const pickupLatitude=coordinate(input.pickupCoordinates,"lat",-90,90);
  const pickupLongitude=coordinate(input.pickupCoordinates,"lng",-180,180);
  if(pickupLatitude===null||pickupLongitude===null)throw new HttpError("Select a verified sender pickup address on the map.",400);
  const pickupAddress=typeof input.pickupAddress==="string"?input.pickupAddress.trim():"";
  if(pickupAddress.length<3||pickupAddress.length>1000)throw new HttpError("Confirm the sender's complete pickup address.",400);
  try{
   const verifiedPickup=await reverseGeocode(pickupLatitude,pickupLongitude);
   if(!verifiedPickup?.address)throw new Error("No readable address");
  }catch(error){
   console.error("Could not verify interstate sender pickup point",error.message);
   throw new HttpError("Please verify the sender's pickup address and map pin before continuing.",422);
  }

  const packageDescription=String(input.description||"").trim();
  const recipientName=String(input.recipientName||"").trim();
  if(!packageDescription||packageDescription.length>2000||!recipientName||recipientName.length>120){
   throw new HttpError("Enter a package description and recipient name.",400);
  }
  let selection;
  try{selection=resolvePackageSelection(input)}
  catch(error){throw new HttpError(error.message,400)}
  if(selection.packageCategory!==input.packageCategory){
   throw new HttpError("The selected package category does not match the measured shipment.",400);
  }
  const {weightKg,lengthCm,widthCm,heightCm}=selection.measurements;
  if(weightKg===null||weightKg<=0)throw new HttpError("Enter a positive package weight so station and vehicle capacity can be checked.",400);
  for(const station of [origin,destination]){
   if(!withinLimit(weightKg,station.maximum_weight_kg)||
    !withinLimit(lengthCm,station.maximum_length_cm)||
    !withinLimit(widthCm,station.maximum_width_cm)||
    !withinLimit(heightCm,station.maximum_height_cm)||
    !station.accepted_categories.includes(input.packageCategory)) {
    throw new HttpError("The shipment exceeds an approved station's accepted package or capacity limits.",422);
   }
  }
  const vehicleClass=selection.vehicleType==="lorry"?"truck":selection.vehicleType==="motorcycle"?"motorcycle":selection.vehicleType;
  if(!route.supported_categories.includes(input.packageCategory)||
    !route.supported_vehicle_classes.includes(vehicleClass)||
    !withinLimit(weightKg,route.maximum_weight_kg)) {
   throw new HttpError("The shipment is not supported by the approved interstate route.",422);
  }
  const {data:pricing,error:pricingError}=await db.from("delivery_pricing_versions").select("*")
   .eq("journey_type","interstate").eq("package_category",input.packageCategory)
   .eq("vehicle_class",vehicleClass).eq("status","published").maybeSingle();
  if(pricingError)throw new HttpError("The published interstate price could not be loaded.",503);
  if(!pricing||Number(pricing.operating_cost_floor)<=0){
   throw new HttpError("Interstate pricing is not enabled until Operations publishes a validated cost floor.",409);
  }
  const routeToOrigin=await routeLeg(
   {latitude:pickupLatitude,longitude:pickupLongitude},
   {latitude:Number(origin.latitude),longitude:Number(origin.longitude)}
  );
  const stationTransfer=await routeLeg(
   {latitude:Number(origin.latitude),longitude:Number(origin.longitude)},
   {latitude:Number(destination.latitude),longitude:Number(destination.longitude)}
  );
  const distanceMeters=routeToOrigin.distanceMeters+stationTransfer.distanceMeters;
  const durationSeconds=routeToOrigin.durationSeconds+stationTransfer.durationSeconds;
  if(distanceMeters<=0)throw new HttpError("A positive road distance to the selected stations could not be calculated.",422);
  if(route.maximum_distance_km!==null&&distanceMeters/1000>Number(route.maximum_distance_km)){
   throw new HttpError("The calculated road route exceeds the approved station route's distance limit.",422);
  }
  let priced;
  try{priced=calculateInterstatePrice(distanceMeters,pricing,input.serviceTier)}
  catch(error){throw new HttpError(error.message,422)}
  const serviceMin=input.serviceTier==="express"?route.express_min_days:route.standard_min_days;
  const serviceMax=input.serviceTier==="express"?route.express_max_days:route.standard_max_days;
  const delayDays=operatingDelayDays({...route,origin_station:origin});
  const minDeliveryDays=serviceMin+delayDays;
  const maxDeliveryDays=serviceMax+delayDays;

  const {data:terms,error:termsError}=await db.from("delivery_terms_acceptances").insert({
   customer_id:user.id,terms_version:DISPATCH_TERMS_VERSION
  }).select("id").single();
  if(termsError)throw new HttpError("The dispatch terms record is not ready. Please contact FemmaDexDrive support before retrying.",503);
  let couponClaimId=null;
  const couponCode=typeof input.couponCode==="string"?input.couponCode.trim():"";
  if(couponCode){
   const {data:claimId,error}=await db.rpc("reserve_delivery_coupon",{p_customer_id:user.id,p_code:couponCode});
   if(error||typeof claimId!=="string"){
    console.error("Interstate delivery coupon reservation failed",error?.message||"No claim returned");
    throw new HttpError(error?.message||"The coupon could not be reserved. Please try again.",400);
   }
   couponClaimId=claimId;
  }
  const orderArgs={
   p_customer_id:user.id,p_route_id:route.id,p_destination_station_id:destination.id,
   p_pickup_state:input.pickupState.trim(),p_destination_state:destination.state,p_destination_city:destination.city,
   p_service_tier:input.serviceTier,p_pricing_version_id:pricing.id,
   p_pickup_address:pickupAddress,p_pickup_latitude:pickupLatitude,p_pickup_longitude:pickupLongitude,
   p_recipient_name:recipientName,p_recipient_phone:String(input.recipientPhone||"").trim().slice(0,40)||null,
   p_goods_description:packageDescription,p_weight_kg:weightKg,p_length_cm:lengthCm,
   p_width_cm:widthCm,p_height_cm:heightCm,p_package_size:selection.packageSize,
   p_package_category:input.packageCategory,p_vehicle_type:vehicleClass,
   p_distance_meters:distanceMeters,p_duration_seconds:durationSeconds,p_suggested_price:priced.price,
   p_min_delivery_days:minDeliveryDays,p_max_delivery_days:maxDeliveryDays
  };
  const {data:order,error:orderError}=await db.rpc("create_interstate_delivery_quote",orderArgs);
  if(orderError||!order?.id){
   if(couponClaimId){
    const {error:releaseError}=await db.rpc("release_delivery_coupon_reservation",{p_claim_id:couponClaimId});
    if(releaseError)console.error("Could not release failed interstate quote coupon reservation",releaseError.message);
   }
   console.error("Interstate delivery quote could not be persisted",orderError?.message||"No order returned");
   throw new HttpError(orderError?.message||"The interstate delivery quote could not be saved.",503);
  }
  let coupon=null;
  if(couponClaimId){
   const {data:claim,error:attachError}=await db.rpc("attach_delivery_coupon",{
    p_claim_id:couponClaimId,p_order_id:order.id,p_customer_id:user.id
   });
   if(attachError||!claim){
    console.error("Interstate quote was saved but its coupon could not be attached",attachError?.message||"No claim returned");
    throw new HttpError(`Quote ${order.tracking_number} was saved, but the coupon could not be attached. Contact FemmaDexDrive support.`,503);
   }
   coupon={code:claim.code_snapshot,discountPercent:Number(claim.discount_percent),status:claim.status};
  }
  const {error:termsLinkError}=await db.from("delivery_terms_acceptances").update({order_id:order.id})
   .eq("id",terms.id).eq("customer_id",user.id);
  if(termsLinkError)throw new HttpError(`Quote ${order.tracking_number} was saved, but its terms record could not be linked. Contact support.`,503);
  return json({
   order,coupon,journeyType:"interstate",serviceTier:input.serviceTier,
   distanceMeters,distanceKm:Number((distanceMeters/1000).toFixed(2)),
   durationSeconds,durationMinutes:Math.ceil(durationSeconds/60),
   suggestedPrice:priced.price,pricingBreakdown:priced.breakdown,
   pickupAddress,destinationStation:order.destination_station_snapshot,
   originStation:order.origin_station_snapshot,transportPartner:route.transport_partner,
   estimatedDeliveryMinDays:minDeliveryDays,estimatedDeliveryMaxDays:maxDeliveryDays,
   pickupStateRequiresOperationsVerification:true,currency:"NGN"
  });
 }catch(error){
  if(!(error instanceof HttpError))console.error("Interstate delivery quote failed",error.message);
  return err(error);
 }
};
