import {sb,json,body,err,userFromRequest,HttpError} from "./_lib.mjs";
import {reverseGeocode} from "./_geocoding.mjs";
import {calculatePriceForDeliverySpeed,calculateSuggestedPrice,resolvePackageSelection} from "./_package-selection.mjs";

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
const normalizedState=value=>{
 const state=String(value||"").trim().toLowerCase().replace(/[().,]/g," ").replace(/\s+/g," ").replace(/\s+state$/,"");
 return ["fct","abuja","federal capital territory"].includes(state)?"federal capital territory":state;
};
const isNigeria=location=>String(location?.countryCode||"").trim().toLowerCase()==="ng"||String(location?.country||"").trim().toLowerCase()==="nigeria";
export function sameNigeriaState(pickup,dropoff){
 const pickupState=normalizedState(pickup?.state),dropoffState=normalizedState(dropoff?.state);
 return isNigeria(pickup)&&isNigeria(dropoff)&&Boolean(pickupState)&&pickupState===dropoffState;
}

export {calculatePriceForDeliverySpeed,calculateSuggestedPrice};

async function releaseCouponReservation(db,claimId){
 if(!claimId)return;
 try{
  const {error}=await db.rpc("release_delivery_coupon_reservation",{p_claim_id:claimId});
  if(error)throw error;
 }catch(error){
  console.error("Could not release a coupon reservation after quote creation failed",{claimId,message:error.message});
 }
}

export default async req=>{
 if(req.method==="OPTIONS")return new Response("",{status:204});
 try{
  const user=await userFromRequest(req);
  const request=await body(req);
  if(!request||typeof request!=="object"||Array.isArray(request))throw new HttpError("Invalid delivery quote request.",400);
  const deliverySpeed=request.deliverySpeed===undefined?"standard":request.deliverySpeed;
  if(!["standard","fast"].includes(deliverySpeed))throw new HttpError("Select a valid delivery speed.",400);
  if(request.termsAccepted!==true||request.termsVersion!==DISPATCH_TERMS_VERSION){
   throw new HttpError("Review and accept the current dispatch terms before requesting a quote.",400);
  }
  const db=sb();
  const {data:profile,error:profileError}=await db.from("profiles").select("role").eq("id",user.id).maybeSingle();
  if(profileError){
   console.error("Could not verify customer role for delivery quote",{code:profileError.code,message:profileError.message});
   throw new HttpError("Your account could not be verified. Please try again.",503);
  }
  if(profile?.role!=="customer")throw new HttpError("A customer account is required to request a delivery quote.",403);
  if(!user.email){
   const customerEmail=String(request.customerEmail||"").trim().toLowerCase();
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)||customerEmail.length>254){
    throw new HttpError("Enter a valid email address so Paystack can send your payment receipt.",400);
   }
   const {error:emailError}=await db.from("profiles").update({email:customerEmail}).eq("id",user.id);
   if(emailError){
    console.error("Could not save guest customer email",{code:emailError.code,message:emailError.message});
    throw new HttpError("Could not save your contact email. Please try again.",503);
   }
  }
  const {data:termsAcceptance,error:termsError}=await db.from("delivery_terms_acceptances").insert({
   customer_id:user.id,
   terms_version:DISPATCH_TERMS_VERSION
  }).select("id").single();
  if(termsError){
   console.error("Could not record dispatch terms acceptance",{code:termsError.code,message:termsError.message});
   throw new HttpError("The dispatch terms record is not ready. Please contact FemmaDexDrive support before retrying.",503);
  }
  const pickupLatitude=coordinate(request.pickupCoordinates,"lat",-90,90);
  const pickupLongitude=coordinate(request.pickupCoordinates,"lng",-180,180);
  const dropoffLatitude=coordinate(request.dropoffCoordinates,"lat",-90,90);
  const dropoffLongitude=coordinate(request.dropoffCoordinates,"lng",-180,180);
  if([pickupLatitude,pickupLongitude,dropoffLatitude,dropoffLongitude].some(value=>value===null)){
   throw new HttpError("Please select valid pickup and delivery locations again.",400);
  }
  const pickupAddress=typeof request.pickupAddress==="string"?request.pickupAddress.trim():"";
  const dropoffAddress=typeof request.dropoffAddress==="string"?request.dropoffAddress.trim():"";
  if(!pickupAddress||pickupAddress.length>1000||!dropoffAddress||dropoffAddress.length>1000){
   throw new HttpError("Confirm pickup and delivery addresses under 1000 characters each.",400);
  }

  const description=String(request.description||"").trim().slice(0,2000);
  const recipientName=String(request.recipientName||"").trim().slice(0,120);
  const couponCode=typeof request.couponCode==="string"?request.couponCode.trim():"";
  if(couponCode.length>48||couponCode&&!/^[a-z0-9_-]{3,48}$/i.test(couponCode)){
   throw new HttpError("Enter a valid coupon code using letters, numbers, hyphens or underscores.",400);
  }
  if(!description)throw new HttpError("Package description is required.",400);
  if(!recipientName)throw new HttpError("Recipient name is required.",400);

  let packageSelection;
  try{
   packageSelection=resolvePackageSelection(request);
  }catch(selectionError){
   throw new HttpError(selectionError.message,400);
  }
  const {packageCategory,packageSize,vehicleType,measurements,requiresManualReview}=packageSelection;
  if(deliverySpeed==="fast"&&!["small","medium"].includes(packageCategory)){
   throw new HttpError("Fast delivery is available for small and medium packages only.",400);
  }

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
  if(!sameNigeriaState(pickup,dropoff)){
   throw new HttpError("This booking is for delivery within one Nigerian state. Confirm both map locations are in the same state, or choose between-states dispatch.",422);
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
  const standardSuggestedPrice=calculateSuggestedPrice(distanceMeters,"small");
  const categoryPrice=packageCategory==="bulky"?calculateSuggestedPrice(distanceMeters,"large"):standardSuggestedPrice;
  const suggestedPrice=calculatePriceForDeliverySpeed(categoryPrice,deliverySpeed);
  let couponClaimId=null;
  if(couponCode){
   const {data:claimId,error:couponError}=await db.rpc("reserve_delivery_coupon",{
    p_customer_id:user.id,
    p_code:couponCode
   });
   if(couponError){
    console.error("Delivery coupon could not be reserved",{code:couponError.code,message:couponError.message});
    if(couponError.code==="PGRST202"||couponError.code==="42883"){
     throw new HttpError("Coupon checkout is not ready. Contact FemmaDexDrive support before submitting this quote.",503);
    }
    throw new HttpError(couponError.message||"This coupon could not be applied.",400);
   }
   if(typeof claimId!=="string")throw new HttpError("The coupon was not reserved. Please try again.",503);
   couponClaimId=claimId;
  }
  const {data:order,error}=await db.rpc("create_delivery_quote_with_options",{
   p_customer_id:user.id,
   p_pickup_address:pickupAddress,
   p_pickup_latitude:pickupLatitude,
   p_pickup_longitude:pickupLongitude,
   p_dropoff_address:dropoffAddress,
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
   p_requires_manual_review:requiresManualReview,
   p_delivery_speed:deliverySpeed
  });
  if(error){
   await releaseCouponReservation(db,couponClaimId);
   console.error("Delivery quote persistence failed",{code:error.code,message:error.message});
   if(error.code==="PGRST202"||error.code==="42883"){
    throw new HttpError("Delivery quote service is not ready. Please contact FemmaDexDrive support before retrying.",503);
   }
   throw new HttpError("Could not save the delivery quote. Please try again later.",500);
  }
  if(!order?.id){
   await releaseCouponReservation(db,couponClaimId);
   console.error("Delivery quote RPC returned no persisted order ID");
   throw new HttpError("Could not confirm that the delivery quote was saved. Please contact support before retrying.",502);
  }
  let coupon=null;
  if(couponClaimId){
   const {data:claim,error:attachError}=await db.rpc("attach_delivery_coupon",{
    p_claim_id:couponClaimId,
    p_order_id:order.id,
    p_customer_id:user.id
   });
   if(attachError||!claim){
    await releaseCouponReservation(db,couponClaimId);
    console.error("Quote was saved but its coupon could not be attached",{orderId:order.id,message:attachError?.message||"No coupon claim returned"});
    throw new HttpError(`Quote ${order.tracking_number} was saved, but its coupon could not be attached. Contact FemmaDexDrive support before requesting another quote.`,503);
   }
   coupon={code:claim.code_snapshot,discountPercent:Number(claim.discount_percent),status:claim.status};
  }
  const {error:linkError}=await db.from("delivery_terms_acceptances")
   .update({order_id:order.id})
   .eq("id",termsAcceptance.id)
   .eq("customer_id",user.id);
  if(linkError){
   console.error("Quote was saved but terms acceptance could not be linked",{orderId:order.id,code:linkError.code,message:linkError.message});
   throw new HttpError(`Quote ${order.tracking_number} was saved, but its terms record could not be linked. Contact support before requesting another quote.`,503);
  }
  return json({
   order,
   pickup,
   dropoff,
   distanceMeters,
   distanceKm:Number(distanceKm.toFixed(2)),
   durationSeconds,
   durationMinutes:Math.ceil(durationSeconds/60),
   deliverySpeed,
   standardSuggestedPrice,
   suggestedPrice,
   priceMultiplier:packageCategory==="bulky"?4:deliverySpeed==="fast"?2:1,
   deliveryDeadlineHours:deliverySpeed==="fast"?2:null,
   coupon,
   currency:"NGN"
  });
 }catch(error){
  if(!(error instanceof HttpError))console.error("Delivery quote could not be created",error.message);
  return err(error);
 }
};
