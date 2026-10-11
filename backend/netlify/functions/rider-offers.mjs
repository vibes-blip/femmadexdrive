import {sb,json,err,userFromRequest,HttpError} from "./_lib.mjs";
import {compatibleVehicle,refreshFastOfferRouteChecks} from "./_fast-dispatch.mjs";

const activeStatuses=["accepted","picked_up","on_the_way","at_door","delivered"];

export default async request=>{
 if(request.method==="OPTIONS")return new Response("",{status:204});
 try{
  const user=await userFromRequest(request),db=sb();
  const [{data:profile,error:profileError},{data:rider,error:riderError}] = await Promise.all([
   db.from("profiles").select("role").eq("id",user.id).maybeSingle(),
   db.from("riders").select("id,vehicle_type,is_online,approval_status").eq("id",user.id).maybeSingle()
  ]);
  if(profileError||riderError)throw new HttpError("Rider eligibility could not be verified. Please refresh.",503);
  if(profile?.role!=="rider"||rider?.approval_status!=="approved"||!rider?.is_online||!rider?.vehicle_type){
   throw new HttpError("An approved, online rider with a registered vehicle is required.",403);
  }

  const {data:active,error:activeError}=await db.from("orders").select("id")
   .eq("rider_id",user.id).in("status",activeStatuses).limit(1);
  if(activeError)throw new HttpError("Your current delivery status could not be verified.",503);
  if(active?.length)return json({offers:[]});

  const {error:dispatchError}=await db.rpc("dispatch_pending_orders");
  if(dispatchError)throw new HttpError("The delivery queue could not be refreshed. Please try again.",503);
  await refreshFastOfferRouteChecks(db,{riderId:user.id});

  const {data:offers,error:offersError}=await db.from("rider_offers")
   .select("id,order_id,offered_at,route_check_status,pickup_eta_minutes,route_checked_at")
   .eq("rider_id",user.id).eq("status","offered").order("offered_at",{ascending:true}).limit(100);
  if(offersError)throw new HttpError("Your delivery offers could not be loaded.",503);
  if(!offers?.length)return json({offers:[]});

  const {data:orders,error:ordersError}=await db.from("orders")
   .select("id,tracking_number,goods_description,weight_kg,package_size,package_category,vehicle_type,distance_km,duration_minutes,final_price,status,payment_status,created_at,delivery_speed,pickup_deadline_at,rider_id")
   .in("id",offers.map(offer=>offer.order_id)).eq("payment_status","paid").is("rider_id",null);
  if(ordersError)throw new HttpError("Your delivery offers could not be loaded.",503);
  const orderById=new Map((orders||[]).map(order=>[order.id,order]));
  const now=Date.now();
  const safeOffers=[];
  for(const offer of offers){
   const order=orderById.get(offer.order_id);
   if(!order||!["paid","searching"].includes(order.status)||!compatibleVehicle(rider.vehicle_type,order.vehicle_type))continue;
   if(order.delivery_speed==="fast"){
    const checkedAt=offer.route_checked_at?Date.parse(offer.route_checked_at):NaN;
    if(offer.route_check_status!=="eligible"||!Number.isFinite(checkedAt)||now-checkedAt<0||now-checkedAt>120_000)continue;
   }
   safeOffers.push({
    ...order,
    offer_id:offer.id,
    offer_requested_at:order.created_at,
    pickup_eta_minutes:offer.pickup_eta_minutes,
    pickup_eta_status:order.delivery_speed==="fast"?"Verified OpenRouteService estimate to pickup; traffic may differ.":null,
   });
  }
  return json({offers:safeOffers});
 }catch(error){
  if(!(error instanceof HttpError))console.error("Could not load rider offers",error.message);
  return err(error);
 }
};
