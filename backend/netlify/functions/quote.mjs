import {sb,json,body,err,userFromRequest,HttpError} from "./_lib.mjs";
import {reverseGeocode} from "./_geocoding.mjs";

const ORS_DIRECTIONS_URL="https://api.openrouteservice.org/v2/directions/driving-car/geojson";
const BASE_FARE=1500;
const INCLUDED_KM=5;
const PRICE_PER_EXTRA_KM=150;
const MINIMUM_FARE=2000;
const PACKAGE_MEDIUM_SURCHARGE=500;
const PACKAGE_LARGE_SURCHARGE=1000;

const optionalAmount=(value,name)=>{
 if(value===null||value===undefined||value==="")return 0;
 if(typeof value!=="number"&&typeof value!=="string")throw new HttpError(`${name} must be a valid non-negative number.`,400);
 if(typeof value==="string"&&!value.trim())throw new HttpError(`${name} must be a valid non-negative number.`,400);
 const amount=Number(value);
 if(!Number.isFinite(amount)||amount<0)throw new HttpError(`${name} must be a valid non-negative number.`,400);
 return amount;
};

const coordinate=(point,key,min,max)=>{
 const value=point?.[key];
 if(value===null||value===undefined||value==="")return null;
 if(typeof value!=="number"&&typeof value!=="string")return null;
 if(typeof value==="string"&&!value.trim())return null;
 const number=Number(value);
 return Number.isFinite(number)&&number>=min&&number<=max?number:null;
};

const packageSizeForWeight=weight=>weight<=2?"small":weight<=5?"medium":weight<=10?"large":"very_large";
const vehicleFor=(weight,size,volume)=>weight>250||size==="very_large"||volume>1_000_000?"lorry":weight>50||size==="large"||volume>250_000?"van":weight>12||size==="medium"||volume>60_000?"car":"motorcycle";

export function calculateSuggestedPrice(distanceMeters,packageSize){
 const distanceKm=distanceMeters/1000;
 const distanceCharge=Math.max(0,distanceKm-INCLUDED_KM)*PRICE_PER_EXTRA_KM;
 const packageAdjustment=packageSize==="small"?0:packageSize==="medium"?PACKAGE_MEDIUM_SURCHARGE:PACKAGE_LARGE_SURCHARGE;
 return Math.max(MINIMUM_FARE,Math.round(BASE_FARE+distanceCharge))+packageAdjustment;
}

export default async req=>{
 if(req.method==="OPTIONS")return new Response("",{status:204});
 try{
  const user=await userFromRequest(req);
  const request=await body(req);
  if(!request||typeof request!=="object"||Array.isArray(request))throw new HttpError("Invalid delivery quote request.",400);
  const db=sb();
  const {data:profile,error:profileError}=await db.from("profiles").select("role").eq("id",user.id).maybeSingle();
  if(profileError){
   console.error("Could not verify customer role for delivery quote",{code:profileError.code,message:profileError.message});
   throw new HttpError("Your account could not be verified. Please try again.",503);
  }
  if(profile?.role!=="customer")throw new HttpError("A customer account is required to request a delivery quote.",403);
  const pickupLatitude=coordinate(request.pickupCoordinates,"lat",-90,90);
  const pickupLongitude=coordinate(request.pickupCoordinates,"lng",-180,180);
  const dropoffLatitude=coordinate(request.dropoffCoordinates,"lat",-90,90);
  const dropoffLongitude=coordinate(request.dropoffCoordinates,"lng",-180,180);
  if([pickupLatitude,pickupLongitude,dropoffLatitude,dropoffLongitude].some(value=>value===null)){
   throw new HttpError("Please select valid pickup and delivery locations again.",400);
  }

  const description=String(request.description||"").trim().slice(0,2000);
  const recipientName=String(request.recipientName||"").trim().slice(0,120);
  if(!description)throw new HttpError("Package description is required.",400);
  if(!recipientName)throw new HttpError("Recipient name is required.",400);

  const weight=optionalAmount(request.weightKg,"Package weight");
  const length=optionalAmount(request.lengthCm,"Package length");
  const width=optionalAmount(request.widthCm,"Package width");
  const height=optionalAmount(request.heightCm,"Package height");
  if(weight>1000||length>10000||width>10000||height>10000){
   throw new HttpError("Package weight or dimensions are outside the supported range.",400);
  }
  if(!["small","medium","large","very_large"].includes(request.size))throw new HttpError("Select a valid package size.",400);
  const packageSize=weight>0?packageSizeForWeight(weight):request.size;
  const volume=length*width*height;
  const vehicleType=vehicleFor(weight,packageSize,volume);

  let pickup,dropoff;
  try{
   [pickup,dropoff]=await Promise.all([
    reverseGeocode(pickupLatitude,pickupLongitude),
    reverseGeocode(dropoffLatitude,dropoffLongitude)
   ]);
  }catch(geocodingError){
   console.error("Could not verify delivery locations",geocodingError.message);
   throw new HttpError("Please verify both pickup and delivery addresses and try again.",422);
  }
  if(!pickup?.address?.trim()||!dropoff?.address?.trim()){
   throw new HttpError("Please verify both pickup and delivery addresses and try again.",422);
  }

  if(!process.env.ORS_API_KEY){
   console.error("OpenRouteService is not configured: ORS_API_KEY is missing.");
   throw new HttpError("Route calculation is temporarily unavailable. Please try again later.",503);
  }
  let routeResponse;
  try{
   routeResponse=await fetch(ORS_DIRECTIONS_URL,{
    method:"POST",
    headers:{"Authorization":process.env.ORS_API_KEY,"Content-Type":"application/json"},
    body:JSON.stringify({
     coordinates:[[pickupLongitude,pickupLatitude],[dropoffLongitude,dropoffLatitude]],
     instructions:false
    })
   });
  }catch(routeError){
   console.error("OpenRouteService request failed",routeError.message);
   throw new HttpError("Unable to calculate the delivery route. Please try again.",502);
  }

  if(!routeResponse.ok){
   console.error("OpenRouteService rejected the route request",{status:routeResponse.status});
   throw new HttpError("Unable to calculate the delivery route. Please try again.",502);
  }

  let routeData;
  try{
   routeData=await routeResponse.json();
  }catch(parseError){
   console.error("OpenRouteService returned invalid route JSON",parseError.message);
   throw new HttpError("Unable to calculate the delivery route. Please try again.",502);
  }
  const summary=routeData.features?.[0]?.properties?.summary;
  const distanceMeters=summary?.distance;
  const durationSeconds=summary?.duration;
  if(typeof distanceMeters!=="number"||!Number.isFinite(distanceMeters)||distanceMeters<0||typeof durationSeconds!=="number"||!Number.isFinite(durationSeconds)||durationSeconds<0){
   console.error("OpenRouteService response did not contain a valid route summary");
   throw new HttpError("Unable to calculate the delivery route. Please try again.",502);
  }

  const distanceKm=distanceMeters/1000;
  const suggestedPrice=calculateSuggestedPrice(distanceMeters,packageSize);
  const requiresManualReview=weight>10||packageSize==="very_large";
  const {data:order,error}=await db.rpc("create_delivery_quote",{
   p_customer_id:user.id,
   p_pickup_address:pickup.address,
   p_pickup_latitude:pickupLatitude,
   p_pickup_longitude:pickupLongitude,
   p_dropoff_address:dropoff.address,
   p_dropoff_latitude:dropoffLatitude,
   p_dropoff_longitude:dropoffLongitude,
   p_recipient_name:recipientName,
   p_recipient_phone:String(request.recipientPhone||"").trim().slice(0,40)||null,
   p_goods_description:description,
   p_weight_kg:weight||null,
   p_length_cm:length||null,
   p_width_cm:width||null,
   p_height_cm:height||null,
   p_package_size:packageSize,
   p_vehicle_type:vehicleType,
   p_distance_meters:distanceMeters,
   p_duration_seconds:durationSeconds,
   p_suggested_price:suggestedPrice,
   p_requires_manual_review:requiresManualReview
  });
  if(error){
   console.error("Delivery quote persistence failed",{code:error.code,message:error.message});
   if(error.code==="PGRST202"||error.code==="42883"){
    throw new HttpError("Delivery quote service is not ready. Please contact FemmaDexDrive support before retrying.",503);
   }
   throw new HttpError("Could not save the delivery quote. Please try again later.",500);
  }
  if(!order?.id){
   console.error("Delivery quote RPC returned no persisted order ID");
   throw new HttpError("Could not confirm that the delivery quote was saved. Please contact support before retrying.",502);
  }
  return json({
   order,
   pickup,
   dropoff,
   distanceMeters,
   distanceKm:Number(distanceKm.toFixed(2)),
   durationSeconds,
   durationMinutes:Math.ceil(durationSeconds/60),
   currency:"NGN"
  });
 }catch(error){
  if(!(error instanceof HttpError))console.error("Delivery quote could not be created",error.message);
  return err(error);
 }
};
