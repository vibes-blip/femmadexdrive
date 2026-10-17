import React,{useEffect,useMemo,useState} from "react";
import {ArrowRight,MapPin,Truck} from "lucide-react";
import {Address,DeliveryLocationMap} from "./MapboxLocation.jsx";
import {apiUrl} from "./api.js";

const states=["Abia","Adamawa","Akwa Ibom","Anambra","Bauchi","Bayelsa","Benue","Borno","Cross River","Delta","Ebonyi","Edo","Ekiti","Enugu","FCT","Gombe","Imo","Jigawa","Kaduna","Kano","Katsina","Kebbi","Kogi","Kwara","Lagos","Nasarawa","Niger","Ogun","Ondo","Osun","Oyo","Plateau","Rivers","Sokoto","Taraba","Yobe","Zamfara"];
const blankForm={pickup:"",pickupCoordinates:null,pickupState:"",destinationState:"",destinationCity:"",routeId:"",packageCategory:"small",serviceTier:"standard",description:"",recipientName:"",recipientPhone:"",customerEmail:"",weightKg:"",lengthCm:"",widthCm:"",heightCm:"",couponCode:""};
const numberOrNull=value=>value===""?null:Number(value);
const money=value=>`₦${Number(value||0).toLocaleString()}`;
const cityName=route=>route.destination_station?.city||"";
const stateName=route=>route.destination_station?.state||"";

export default function InterstateBooking({supabase,session,open,toast,onCreated}){
 const [form,setForm]=useState(blankForm);
 const [routes,setRoutes]=useState([]);
 const [loadingRoutes,setLoadingRoutes]=useState(false);
 const [loadingQuote,setLoadingQuote]=useState(false);
 const [termsAccepted,setTermsAccepted]=useState(false);
 const [quote,setQuote]=useState(null);
 const [mapOpen,setMapOpen]=useState(false);
 const [error,setError]=useState("");
 const [draftReady,setDraftReady]=useState(false);
 const draftKey=`fddInterstateDraft:${session?.user?.id||"guest"}`;

 useEffect(()=>{
  if(draftReady)return;
  const saved=sessionStorage.getItem(draftKey)||(session?sessionStorage.getItem("fddInterstateDraft:guest"):null);
  if(saved){
   try{
    const draft=JSON.parse(saved);
    if(!draft?.form||typeof draft.form!=="object")throw new Error("Saved interstate draft is invalid.");
    setForm(current=>({...current,...draft.form}));
    if(session&&!sessionStorage.getItem(draftKey)){
     sessionStorage.setItem(draftKey,saved);
     sessionStorage.removeItem("fddInterstateDraft:guest");
    }
   }catch(draftError){
    sessionStorage.removeItem(draftKey);
    if(session)sessionStorage.removeItem("fddInterstateDraft:guest");
    toast(`Could not restore your interstate draft: ${draftError.message}`);
   }
  }
  setDraftReady(true);
 },[draftKey,draftReady,session,toast]);

 useEffect(()=>{
  if(!draftReady||quote)return;
  try{sessionStorage.setItem(draftKey,JSON.stringify({form,savedAt:Date.now()}))}
  catch(storageError){toast(`Could not save the interstate draft: ${storageError.message}`)}
 },[draftReady,form,quote,draftKey,toast]);

 useEffect(()=>{
  if(!session||!form.pickupState||!form.packageCategory)return;
  let current=true;
  setLoadingRoutes(true);
  setError("");
  supabase.rpc("list_interstate_delivery_routes",{
   p_origin_state:form.pickupState,
   p_destination_state:null,
   p_destination_city:null,
   p_package_category:form.packageCategory,
   p_service_tier:form.serviceTier,
   p_weight_kg:numberOrNull(form.weightKg),
   p_length_cm:numberOrNull(form.lengthCm),
   p_width_cm:numberOrNull(form.widthCm),
   p_height_cm:numberOrNull(form.heightCm)
  }).then(({data,error:routeError})=>{
   if(!current)return;
   if(routeError)throw routeError;
   const available=data||[];
   setRoutes(available);
   if(!available.some(route=>route.route_id===form.routeId)){
    setForm(currentForm=>({...currentForm,routeId:""}));
   }
  }).catch(routeError=>{
   if(current){setRoutes([]);setError(`Could not load eligible station routes: ${routeError.message}`)}
  }).finally(()=>{
   if(current)setLoadingRoutes(false);
  });
  return()=>{current=false};
 },[session?.user?.id,form.pickupState,form.packageCategory,form.serviceTier,form.weightKg,form.lengthCm,form.widthCm,form.heightCm,supabase]);

 const destinationStates=useMemo(()=>[...new Set(routes.map(stateName).filter(Boolean))].sort(),[routes]);
 const destinationCities=useMemo(()=>[...new Set(routes.filter(route=>!form.destinationState||stateName(route)===form.destinationState).map(cityName).filter(Boolean))].sort(),[routes,form.destinationState]);
 const stationRoutes=useMemo(()=>routes.filter(route=>
  (!form.destinationState||stateName(route)===form.destinationState)&&
  (!form.destinationCity||cityName(route)===form.destinationCity)
 ),[routes,form.destinationState,form.destinationCity]);
 const selectedRoute=stationRoutes.find(route=>route.route_id===form.routeId)||routes.find(route=>route.route_id===form.routeId)||null;

 const update=(key,value)=>{setForm(current=>({...current,[key]:value}));setQuote(null);setError("")};
 const pickPickup=(address,point)=>{
  setForm(current=>({...current,pickup:address,pickupCoordinates:point,routeId:""}));
  setQuote(null);
 };
 const changePickup=value=>{
  setForm(current=>({...current,pickup:value,pickupCoordinates:null,routeId:""}));
  setQuote(null);
 };
 const selectDestinationState=value=>{setForm(current=>({...current,destinationState:value,destinationCity:"",routeId:""}));setQuote(null)};
 const selectDestinationCity=value=>{setForm(current=>({...current,destinationCity:value,routeId:""}));setQuote(null)};
 const prepareQuote=async event=>{
  event.preventDefault();
  if(loadingQuote)return;
  if(!session){
   try{sessionStorage.setItem(draftKey,JSON.stringify({form,savedAt:Date.now()}))}
   catch(storageError){return setError(`Could not save your draft before signing in: ${storageError.message}`)}
   open("customer","login");
   toast("Your interstate booking draft is saved. Sign in to check eligible stations and request a quote.");
   return;
  }
  if(!termsAccepted)return setError("Review and accept the dispatch terms before requesting a quote.");
  if(!form.pickup||!form.pickupCoordinates)return setError("Select and confirm the sender's exact pickup address and map point.");
  if(!form.pickupState)return setError("Select the sender's pickup state. Operations will verify it before approving the price.");
  if(!form.destinationState||!form.destinationCity||!selectedRoute)return setError("Choose an active destination state, city and approved pickup station.");
  if(!form.description.trim()||!form.recipientName.trim())return setError("Enter package details and the recipient's name.");
  if(!form.weightKg||!Number.isFinite(Number(form.weightKg))||Number(form.weightKg)<=0)return setError("Enter a positive package weight so station and vehicle capacity can be checked.");
  setLoadingQuote(true);
  setError("");
  try{
   const response=await fetch(apiUrl("interstate-quote"),{
    method:"POST",
    headers:{"Content-Type":"application/json",Authorization:`Bearer ${session.access_token}`},
    body:JSON.stringify({
     routeId:selectedRoute.route_id,
     destinationStationId:selectedRoute.destination_station?.id,
     pickupState:form.pickupState,
     destinationState:form.destinationState,
     destinationCity:form.destinationCity,
     pickupAddress:form.pickup.trim(),
     pickupCoordinates:form.pickupCoordinates,
     packageCategory:form.packageCategory,
     serviceTier:form.serviceTier,
     description:form.description,
     recipientName:form.recipientName,
     recipientPhone:form.recipientPhone,
     customerEmail:form.customerEmail,
     weightKg:numberOrNull(form.weightKg),
     lengthCm:numberOrNull(form.lengthCm),
     widthCm:numberOrNull(form.widthCm),
     heightCm:numberOrNull(form.heightCm),
     couponCode:form.couponCode,
     termsVersion:"dispatch-terms-2026-10-12",
     termsAccepted:true
    })
   });
   const data=await response.json().catch(()=>({}));
   if(!response.ok)throw new Error(data.error||"Interstate quote could not be requested.");
   setQuote(data);
   onCreated?.(data.order);
   sessionStorage.removeItem(draftKey);
   toast("Interstate quote submitted. Operations must verify the pickup state and price before payment.");
  }catch(requestError){setError(requestError.message)}
  finally{setLoadingQuote(false)}
 };
 const mappedOrder=selectedRoute&&form.pickupCoordinates?{
  pickup_latitude:form.pickupCoordinates.lat,
  pickup_longitude:form.pickupCoordinates.lng,
  pickup_address:form.pickup,
  dropoff_latitude:selectedRoute.destination_station.latitude,
  dropoff_longitude:selectedRoute.destination_station.longitude,
  dropoff_address:selectedRoute.destination_station.address
 }:null;
 const selectedStationRoute=selectedRoute?{
  origin:selectedRoute.origin_station,
  destination:selectedRoute.destination_station
 }:null;

 return <section className="panel interstate-booking" aria-labelledby="interstate-booking-title">
  <div className="panel-head"><div><span className="eyebrow">STATION COLLECTION</span><h2 id="interstate-booking-title">Interstate delivery</h2></div><Truck/></div>
  <p>Doorstep pickup from the sender; collection at an approved destination station. No destination doorstep delivery is included.</p>
  {!session&&<div className="notice">You can prepare the pickup draft now. Sign in to load approved station routes and request an interstate quote.</div>}
  <form className="form" onSubmit={prepareQuote}>
   <Address label="Sender's exact doorstep pickup address" value={form.pickup} coordinates={form.pickupCoordinates} onChange={changePickup} onSelect={pickPickup}/>
   <p className="package-choice-help">Enter the sender's real doorstep address above, then select the state they are actually in. The sender is not asked to travel to a bus terminal; approved stations are selected separately below.</p>
   <label>Sender pickup state (selected by you; Operations verifies it)<select value={form.pickupState} onChange={event=>{update("pickupState",event.target.value);update("routeId","")}} required>
    <option value="">Select pickup state</option>{states.map(state=><option key={state}>{state}</option>)}
   </select></label>
   <fieldset className="package-section"><legend>Interstate package type</legend><p className="package-choice-help">Choose by the size and handling needs of your packed goods. Give the actual weight and, for bulky items, dimensions so we can check the approved station and route limits.</p><div className="package-cards interstate-package-cards">
    {[{id:"small",name:"Small",description:"A single compact parcel, such as shoes in a box, a book, phone, small gift, clothing, groceries, or a securely sealed meal/snack for immediate consumption. Food must be leak-resistant; special temperature-controlled handling is not promised.",image:"/images/package-small.jpg",alt:"Rider preparing a small parcel"},{id:"medium",name:"Medium",description:"A handbag, grocery bag, several small items together, or a medium carton/small appliance that fits an approved vehicle. Include the packed weight and exact contents.",image:"/images/package-medium.svg",alt:"Illustration of a medium parcel"},{id:"bulky",name:"Large / bulky",description:"Furniture, large appliances, equipment, or heavy/awkward cargo. Enter all three dimensions and the weight; a van or truck and station acceptance must be verified.",image:"/images/package-bulky.jpg",alt:"Illustration of furniture and bulky parcels"}].map(item=><label className={`package-card ${form.packageCategory===item.id?"selected":""}`} key={item.id}>
     <input type="radio" name="interstate-package-category" value={item.id} checked={form.packageCategory===item.id} onChange={()=>{update("packageCategory",item.id);update("routeId","")}}/>
     <img src={item.image} alt={item.alt}/>
     <span className="package-card-copy"><strong>{item.name}</strong><small>{item.description}</small></span>
    </label>)}
   </div></fieldset>
   <div className="two">
    <label>Service<select value={form.serviceTier} onChange={event=>{update("serviceTier",event.target.value);update("routeId","")}}><option value="standard">Standard · route estimate</option><option value="express">Express · only on supported routes</option></select></label>
    <label>Package weight (kg)<input type="number" min="0.1" step="0.1" value={form.weightKg} onChange={event=>update("weightKg",event.target.value)} required/></label>
   </div>
   {form.packageCategory==="bulky"&&<div className="two interstate-dimensions">
    <label>Length (cm)<input type="number" min="1" step="0.1" value={form.lengthCm} onChange={event=>update("lengthCm",event.target.value)}/></label>
    <label>Width (cm)<input type="number" min="1" step="0.1" value={form.widthCm} onChange={event=>update("widthCm",event.target.value)}/></label>
    <label>Height (cm)<input type="number" min="1" step="0.1" value={form.heightCm} onChange={event=>update("heightCm",event.target.value)}/></label>
   </div>}
   <label>Destination state<select value={form.destinationState} onChange={event=>selectDestinationState(event.target.value)} disabled={!session||loadingRoutes||!form.pickupState} required>
    <option value="">{loadingRoutes?"Loading active routes…":"Select an active destination state"}</option>{destinationStates.map(state=><option key={state}>{state}</option>)}
   </select></label>
   <label>Destination city<select value={form.destinationCity} onChange={event=>selectDestinationCity(event.target.value)} disabled={!form.destinationState} required>
    <option value="">Select an eligible city</option>{destinationCities.map(city=><option key={city}>{city}</option>)}
   </select></label>
   <fieldset className="interstate-station-list"><legend>Approved destination pickup stations</legend>
    {!stationRoutes.length?<p>{loadingRoutes?"Loading stations…":"No active station route matches the selected states, city, package and service."}</p>:stationRoutes.map(route=>{
     const station=route.destination_station;
     return <label className={`interstate-station-option ${form.routeId===route.route_id?"selected":""}`} key={route.route_id}>
      <input type="radio" name="interstate-route" value={route.route_id} checked={form.routeId===route.route_id} onChange={()=>update("routeId",route.route_id)}/>
      <span><b>{station.name}</b><small>{station.address}, {station.city}, {station.state}</small>
       <small>Open hours: {JSON.stringify(station.opening_hours||{})}</small>
       <small>Collection point · {route.standard_min_days}–{route.standard_max_days} days standard{route.express_available?` · ${route.express_min_days}–${route.express_max_days} days express`:""}</small>
       <small>Transport partner: {route.transport_partner}</small>
      </span>
     </label>
    })}</fieldset>
   {selectedRoute&&<div className="notice interstate-route-details">
    <b>Sender pickup remains separate</b><span>{form.pickup||"Select the sender's complete doorstep address first."}</span>
    <b>Origin terminal</b><span>{selectedRoute.origin_station.name} · {selectedRoute.origin_station.address}</span>
    <b>Destination collection station</b><span>{selectedRoute.destination_station.name} · {selectedRoute.destination_station.address}</span>
    <button className="secondary" type="button" disabled={!mappedOrder} onClick={()=>setMapOpen(true)}><MapPin size={15}/> View pickup and both stations on map</button>
   </div>}
   <label>Package description<textarea value={form.description} onChange={event=>update("description",event.target.value)} maxLength="2000" required/></label>
   <div className="two"><label>Recipient name<input value={form.recipientName} onChange={event=>update("recipientName",event.target.value)} maxLength="120" required/></label>
    <label>Recipient phone<input type="tel" value={form.recipientPhone} onChange={event=>update("recipientPhone",event.target.value)} maxLength="40"/></label></div>
   {!session?.user?.email&&<label>Contact email<input type="email" autoComplete="email" value={form.customerEmail} onChange={event=>update("customerEmail",event.target.value)} required/></label>}
   <label>Coupon code (optional)<input value={form.couponCode} onChange={event=>update("couponCode",event.target.value)} maxLength="48"/></label>
   <div className="interstate-collection-notice"><b>Interstate collection notice</b><p>Interstate delivery ends at the selected pickup station. The recipient must collect the package there. Destination doorstep delivery is not included.</p></div>
   <label className="terms-consent interstate-terms"><input type="checkbox" checked={termsAccepted} onChange={event=>setTermsAccepted(event.target.checked)}/><span>I have read and agree to the <a href="/terms" target="_blank" rel="noreferrer">dispatch terms and return policy</a>.</span></label>
   {error&&<p className="address-error" role="alert">{error}</p>}
   <button className="primary wide" disabled={loadingQuote}>{loadingQuote?"Calculating route…":session?"Request interstate quote":"Sign in to request quote"} <ArrowRight size={17}/></button>
  </form>
  {quote&&<div className="quote interstate-quote-summary" aria-live="polite">
   <span className="eyebrow">INTERSTATE QUOTE · AWAITING OPERATIONS</span>
   <h3>{money(quote.suggestedPrice)} suggested</h3>
   <p>{quote.distanceKm} km road route · {quote.durationMinutes} driving minutes (route travel only)</p>
   <p>Estimated delivery: {quote.estimatedDeliveryMinDays}–{quote.estimatedDeliveryMaxDays} days, subject to the approved route schedule.</p>
   <p><b>Sender pickup:</b> {quote.order.pickup_address}</p>
   <p><b>Destination collection:</b> {quote.destinationStation?.name} · {quote.destinationStation?.address}</p>
   <p><b>Pickup state:</b> {quote.order.pickup_state} · awaiting Operations verification</p>
   <p>Payment remains unavailable until Operations verifies the sender's pickup state and approves the final price.</p>
  </div>}
  {mapOpen&&mappedOrder&&selectedStationRoute&&<DeliveryLocationMap order={mappedOrder} stationRoute={selectedStationRoute} onClose={()=>setMapOpen(false)}/>}
 </section>;
}
