import {sb,json,body,err,userFromRequest,HttpError} from "./_lib.mjs";
import {reverseGeocode} from "./_geocoding.mjs";
import {calculateSuggestedPrice,resolvePackageSelection} from "./_package-selection.mjs";

const ORS_DIRECTIONS_URL="https://api.openrouteservice.org/v2/directions/driving-car/geojson";
const coordinate=(point,key,min,max)=>{
 const value=point?.[key];
 if(value===null||value===undefined||value==="")return null;
 if(typeof value!=="number"&&typeof value!=="string")return null;
 if(typeof value==="string"&&!value.trim())return null;
 const number=Number(value);
 return Number.isFinite(number)&&number>=min&&number<=max?number:null;
};

export {calculateSuggestedPrice};

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

  let packageSelection;
  try{
   packageSelection=resolvePackageSelection(request);
  }catch(selectionError){
   throw new HttpError(selectionError.message,400);
  }
  const {packageCategory,packageSize,vehicleType,measurements,requiresManualReview}=packageSelection;

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
  const {data:order,error}=await db.rpc("create_delivery_quote_with_category",{
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
   p_weight_kg:measurements.weightKg,
   p_length_cm:measurements.lengthCm,
   p_width_cm:measurements.widthCm,
   p_height_cm:measurements.heightCm,
   p_package_size:packageSize,
   p_package_category:packageCategory,
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
