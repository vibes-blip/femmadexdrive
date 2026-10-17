import React,{useEffect,useMemo,useState} from "react";
import {Address} from "./MapboxLocation.jsx";
import {apiUrl} from "./api.js";
import {CheckCircle2,Plus,RefreshCw,Save,Truck} from "lucide-react";

const categories=["small","medium","bulky"];
const vehicles=["motorcycle","car","van","truck"];
const days=[{id:1,label:"Mon"},{id:2,label:"Tue"},{id:3,label:"Wed"},{id:4,label:"Thu"},{id:5,label:"Fri"},{id:6,label:"Sat"},{id:7,label:"Sun"}];
const stages=[
 {id:"pickup_rider_assigned",label:"Pickup rider assigned"},
 {id:"collected_from_sender",label:"Collected from sender"},
 {id:"arrived_origin_terminal",label:"Arrived at origin terminal"},
 {id:"transport_partner_received",label:"Handed to transport partner"},
 {id:"in_transit",label:"In interstate transit"},
 {id:"arrived_destination_station",label:"Arrived at destination station"},
 {id:"ready_for_collection",label:"Ready for recipient collection"},
 {id:"recipient_collected",label:"Recipient collected"}
];
const blankStation={id:"",name:"",address:"",state:"",city:"",latitude:null,longitude:null,contact_phone:"",opening_hours:"{}",operational_status:"operational",active:false,accepts_outgoing:false,accepts_incoming:false,accepted_categories:["small","medium"],maximum_weight_kg:"",maximum_length_cm:"",maximum_width_cm:"",maximum_height_cm:"",cutoff_time:"",collection_instructions:""};
const blankRoute={id:"",origin_station_id:"",destination_station_id:"",transport_partner:"",active:false,standard_min_days:1,standard_max_days:7,express_available:false,express_min_days:1,express_max_days:3,supported_categories:["small"],supported_vehicle_classes:["motorcycle"],maximum_weight_kg:"",maximum_distance_km:"",operating_days:[1,2,3,4,5,6],departure_cutoff:"",last_verified_at:null};
const blankPrice={id:"",journey_type:"interstate",package_category:"small",vehicle_class:"motorcycle",base_fare:"500",minimum_fare:"0",distance_bands:'[{"up_to_km":100,"rate_per_km":300},{"up_to_km":300,"rate_per_km":220},{"up_to_km":700,"rate_per_km":180}]',maximum_distance_km:"700",operating_cost_floor:"0",express_premium_percent:"25",notes:"Draft only. Validate operating cost before publication."};
const optionalNumber=value=>value===""||value===null?null:Number(value);
const money=value=>`₦${Number(value||0).toLocaleString()}`;
const checkError=result=>{if(result.error)throw result.error;return result.data};

export default function InterstateOperations({supabase,session,toast}){
 const [stations,setStations]=useState([]);
 const [routes,setRoutes]=useState([]);
 const [prices,setPrices]=useState([]);
 const [orders,setOrders]=useState([]);
 const [events,setEvents]=useState([]);
 const [station,setStation]=useState(blankStation);
 const [route,setRoute]=useState(blankRoute);
 const [price,setPrice]=useState(blankPrice);
 const [pickupNote,setPickupNote]=useState({});
 const [shipmentNote,setShipmentNote]=useState({});
 const [previewDistance,setPreviewDistance]=useState("100");
 const [previewTier,setPreviewTier]=useState("standard");
 const [preview,setPreview]=useState(null);
 const [busy,setBusy]=useState("");
 const [error,setError]=useState("");

 const load=async()=>{
  setError("");
  try{
   const [stationResult,routeResult,priceResult,orderResult]=await Promise.all([
    supabase.from("delivery_stations").select("*").order("state").order("city").order("name"),
    supabase.from("delivery_routes").select("*").order("created_at",{ascending:false}),
    supabase.from("delivery_pricing_versions").select("*").order("version",{ascending:false}),
    supabase.from("orders").select("id,tracking_number,status,payment_status,pickup_state,pickup_state_status,pickup_address,destination_station_snapshot,interstate_route_snapshot,journey_type,estimated_delivery_min_days,estimated_delivery_max_days,created_at").eq("journey_type","interstate").order("created_at",{ascending:false}).limit(100)
   ]);
   const stationRows=checkError(stationResult)||[];
   const routeRows=checkError(routeResult)||[];
   const priceRows=checkError(priceResult)||[];
   const orderRows=checkError(orderResult)||[];
   setStations(stationRows);setRoutes(routeRows);setPrices(priceRows);setOrders(orderRows);
   if(orderRows.length){
    const eventResult=await supabase.from("order_events").select("id,order_id,actor_id,event,note,created_at").in("order_id",orderRows.map(item=>item.id)).order("created_at",{ascending:true});
    setEvents(checkError(eventResult)||[]);
   }else setEvents([]);
  }catch(loadError){setError(`Could not load interstate operations: ${loadError.message}`);toast(`Could not load interstate operations: ${loadError.message}`)}
 };
 useEffect(()=>{void load()},[session?.user?.id]);

 const stationOptions=useMemo(()=>stations.map(item=>({id:item.id,name:`${item.name} · ${item.city}, ${item.state}`})),[stations]);
 const updateStation=(key,value)=>setStation(current=>({...current,[key]:value}));
 const updateRoute=(key,value)=>setRoute(current=>({...current,[key]:value}));
 const updatePrice=(key,value)=>{setPrice(current=>({...current,[key]:value}));setPreview(null)};
 const toggleList=(setter,key,value)=>setter(current=>({...current,[key]:current[key].includes(value)?current[key].filter(item=>item!==value):[...current[key],value]}));
 const resetStation=()=>setStation({...blankStation,accepted_categories:[...blankStation.accepted_categories]});
 const resetRoute=()=>setRoute({...blankRoute,supported_categories:[...blankRoute.supported_categories],supported_vehicle_classes:[...blankRoute.supported_vehicle_classes],operating_days:[...blankRoute.operating_days]});

 const editStation=item=>setStation({
  ...item,
  opening_hours:JSON.stringify(item.opening_hours||{},null,2),
  cutoff_time:item.cutoff_time||"",
  maximum_weight_kg:item.maximum_weight_kg??"",
  maximum_length_cm:item.maximum_length_cm??"",
  maximum_width_cm:item.maximum_width_cm??"",
  maximum_height_cm:item.maximum_height_cm??""
 });
 const saveStation=async event=>{
  event.preventDefault();setBusy("station");setError("");
  try{
   const hours=JSON.parse(station.opening_hours||"{}");
   if(!hours||Array.isArray(hours)||typeof hours!=="object")throw new Error("Opening hours must be a JSON object.");
   if(station.latitude===null||station.longitude===null)throw new Error("Select and confirm the station's exact address and map pin.");
   const payload={
    name:station.name.trim(),address:station.address.trim(),state:station.state.trim(),city:station.city.trim(),
    latitude:Number(station.latitude),longitude:Number(station.longitude),contact_phone:station.contact_phone.trim()||null,
    opening_hours:hours,operational_status:station.operational_status,active:station.active,
    accepts_outgoing:station.accepts_outgoing,accepts_incoming:station.accepts_incoming,
    accepted_categories:station.accepted_categories,maximum_weight_kg:optionalNumber(station.maximum_weight_kg),
    maximum_length_cm:optionalNumber(station.maximum_length_cm),maximum_width_cm:optionalNumber(station.maximum_width_cm),
    maximum_height_cm:optionalNumber(station.maximum_height_cm),cutoff_time:station.cutoff_time||null,
    collection_instructions:station.collection_instructions.trim()||null,updated_by:session.user.id
   };
   if(station.id)checkError(await supabase.from("delivery_stations").update(payload).eq("id",station.id));
   else checkError(await supabase.from("delivery_stations").insert({...payload,created_by:session.user.id}));
   toast(station.id?"Station updated.":"Station added.");resetStation();await load();
  }catch(saveError){setError(saveError.message);toast(`Could not save station: ${saveError.message}`)}
  finally{setBusy("")}
 };

 const editRoute=item=>setRoute({
  ...item,
  maximum_weight_kg:item.maximum_weight_kg??"",
  maximum_distance_km:item.maximum_distance_km??"",
  departure_cutoff:item.departure_cutoff||""
 });
 const saveRoute=async event=>{
  event.preventDefault();setBusy("route");setError("");
  try{
   if(!route.origin_station_id||!route.destination_station_id||route.origin_station_id===route.destination_station_id)throw new Error("Choose two different verified stations.");
   if(!route.supported_categories.length||!route.supported_vehicle_classes.length||!route.operating_days.length)throw new Error("Choose at least one supported category, vehicle class and operating day.");
   const payload={
    origin_station_id:route.origin_station_id,destination_station_id:route.destination_station_id,
    transport_partner:route.transport_partner.trim(),active:route.active,
    standard_min_days:Number(route.standard_min_days),standard_max_days:Number(route.standard_max_days),
    express_available:route.express_available,
    express_min_days:route.express_available?Number(route.express_min_days):null,
    express_max_days:route.express_available?Number(route.express_max_days):null,
    supported_categories:route.supported_categories,supported_vehicle_classes:route.supported_vehicle_classes,
    maximum_weight_kg:optionalNumber(route.maximum_weight_kg),maximum_distance_km:optionalNumber(route.maximum_distance_km),
    operating_days:route.operating_days,departure_cutoff:route.departure_cutoff||null,
    last_verified_at:route.active?new Date().toISOString():route.last_verified_at,
    updated_by:session.user.id
   };
   if(route.id)checkError(await supabase.from("delivery_routes").update(payload).eq("id",route.id));
   else checkError(await supabase.from("delivery_routes").insert({...payload,created_by:session.user.id}));
   toast(route.active?"Route saved and Operations verified it.":"Route draft saved inactive.");resetRoute();await load();
  }catch(saveError){setError(saveError.message);toast(`Could not save route: ${saveError.message}`)}
  finally{setBusy("")}
 };

 const editPrice=item=>setPrice({
  ...item,id:item.status==="draft"?item.id:"",
  distance_bands:JSON.stringify(item.distance_bands,null,2),
  base_fare:String(item.base_fare),minimum_fare:String(item.minimum_fare),
  maximum_distance_km:item.maximum_distance_km??"",
  operating_cost_floor:String(item.operating_cost_floor),
  express_premium_percent:String(item.express_premium_percent)
 });
 const parsedPrice=()=>{
  const bands=JSON.parse(price.distance_bands);
  if(!Array.isArray(bands))throw new Error("Distance bands must be a JSON array.");
  return {
   base_fare:Number(price.base_fare),minimum_fare:Number(price.minimum_fare),
   distance_bands:bands,maximum_distance_km:optionalNumber(price.maximum_distance_km),
   operating_cost_floor:Number(price.operating_cost_floor),express_premium_percent:Number(price.express_premium_percent)
  };
 };
 const savePrice=async event=>{
  event.preventDefault();setBusy("price");setError("");
  try{
   const payload={...parsedPrice(),journey_type:price.journey_type,package_category:price.package_category,vehicle_class:price.vehicle_class,
    notes:price.notes.trim()||null,created_by:session.user.id};
   if(price.id)checkError(await supabase.from("delivery_pricing_versions").update(payload).eq("id",price.id).eq("status","draft"));
   else checkError(await supabase.from("delivery_pricing_versions").insert(payload));
   toast(price.id?"Pricing draft saved.":"New pricing revision saved as a draft.");setPrice(current=>({...current,id:""}));await load();
  }catch(saveError){setError(saveError.message);toast(`Could not save pricing draft: ${saveError.message}`)}
  finally{setBusy("")}
 };
 const publishPrice=async()=>{
  if(!price.id)return setError("Save this pricing revision as a draft before publishing.");
  setBusy("publish");setError("");
  try{
   const {data,error:rpcError}=await supabase.rpc("publish_delivery_pricing_version",{p_version_id:price.id});
   if(rpcError)throw rpcError;
   if(!data)throw new Error("The pricing schedule was not returned after publication.");
   toast(`Pricing version ${data.version} published after server-side validation.`);await load();
  }catch(publishError){setError(publishError.message);toast(`Could not publish pricing: ${publishError.message}`)}
  finally{setBusy("")}
 };
 const previewPrice=async()=>{
  setBusy("preview");setError("");setPreview(null);
  try{
   const response=await fetch(apiUrl("admin-pricing-preview"),{
    method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${session.access_token}`},
    body:JSON.stringify({pricing:parsedPrice(),distanceMeters:Number(previewDistance)*1000,serviceTier:previewTier})
   });
   const result=await response.json().catch(()=>({}));
   if(!response.ok)throw new Error(result.error||"Could not preview this price.");
   setPreview(result);
  }catch(previewError){setError(previewError.message)}
  finally{setBusy("")}
 };
 const verifyPickup=async(order,verified)=>{
  setBusy(`verify:${order.id}`);setError("");
  try{
   const note=String(pickupNote[order.id]||"").trim();
   if(note.length<3)throw new Error("Enter an audit note of at least 3 characters.");
   const {data,error:rpcError}=await supabase.rpc("set_delivery_pickup_state",{
    p_order_id:order.id,p_pickup_state:order.pickup_state,p_verified:verified,p_note:note
   });
   if(rpcError)throw rpcError;
   toast(data?.pickup_state_status==="verified"?"Pickup state verified; quote review can continue.":"Pickup state rejected; approval and payment remain blocked.");
   await load();
  }catch(actionError){setError(actionError.message);toast(`Could not record pickup-state decision: ${actionError.message}`)}
  finally{setBusy("")}
 };
 const recordShipmentStage=async(order,stage)=>{
  setBusy(`stage:${order.id}`);setError("");
  try{
   const note=String(shipmentNote[order.id]||"").trim();
   if(note.length<5)throw new Error("Enter an auditable handoff or collection note of at least 5 characters.");
   const {error:rpcError}=await supabase.rpc("advance_interstate_shipment",{p_order_id:order.id,p_stage:stage,p_note:note});
   if(rpcError)throw rpcError;
   toast(`${stages.find(item=>item.id===stage)?.label||stage} recorded.`);await load();
  }catch(actionError){setError(actionError.message);toast(`Could not record shipment milestone: ${actionError.message}`)}
  finally{setBusy("")}
 };
 const eventsFor=order=>events.filter(item=>item.order_id===order.id);
 const stationById=id=>stations.find(item=>item.id===id);
 const nextStage=order=>{
  const completed=new Set(eventsFor(order).map(item=>item.event));
  const next=stages.find(item=>!completed.has(item.id));
  if(!next)return null;
  if(next.id==="pickup_rider_assigned"||next.id==="collected_from_sender")return null;
  if(next.id==="arrived_origin_terminal"&&order.status!=="delivered")return null;
  if(order.payment_status!=="paid"||order.pickup_state_status!=="verified")return null;
  if(stages.slice(0,stages.indexOf(next)).some(item=>!completed.has(item.id)))return null;
  return next;
 };
 const activePrices=prices.filter(item=>item.status==="published");

 return <main className="page interstate-operations">
  <section className="panel">
   <div className="panel-head"><div><span className="eyebrow">OPERATIONS CONFIGURATION</span><h2>Stations, routes & interstate pricing</h2></div><Truck/></div>
   <p>No stations or carrier availability are assumed. Only stations and routes entered, verified and activated by Operations appear to customers.</p>
   {error&&<p className="address-error" role="alert">{error}</p>}
   <div className="interstate-admin-columns">
    <form className="form interstate-admin-form" onSubmit={saveStation}>
     <div className="interstate-section-title"><h3>{station.id?"Edit station":"Add a station"}</h3><button type="button" className="ghost" onClick={resetStation}><Plus size={15}/> New</button></div>
     <label>Station name<input required maxLength="160" value={station.name} onChange={event=>updateStation("name",event.target.value)}/></label>
     <Address label="Station street address and map pin" value={station.address} coordinates={station.latitude===null?null:{lat:Number(station.latitude),lng:Number(station.longitude)}} onChange={value=>setStation(current=>({...current,address:value,latitude:null,longitude:null}))} onSelect={(address,point)=>setStation(current=>({...current,address,latitude:point.lat,longitude:point.lng}))}/>
     <div className="two"><label>State<input required maxLength="80" value={station.state} onChange={event=>updateStation("state",event.target.value)}/></label><label>City<input required maxLength="100" value={station.city} onChange={event=>updateStation("city",event.target.value)}/></label></div>
     <div className="two"><label>Contact phone<input maxLength="40" value={station.contact_phone||""} onChange={event=>updateStation("contact_phone",event.target.value)}/></label><label>Daily cutoff<input type="time" value={station.cutoff_time||""} onChange={event=>updateStation("cutoff_time",event.target.value)}/></label></div>
     <label>Opening hours (JSON object)<textarea rows="4" value={station.opening_hours} onChange={event=>updateStation("opening_hours",event.target.value)} placeholder='{"Monday":"08:00-18:00"}'/></label>
     <div className="two"><label>Maximum weight (kg)<input type="number" min="0.1" step="0.1" value={station.maximum_weight_kg} onChange={event=>updateStation("maximum_weight_kg",event.target.value)}/></label><label>Maximum length (cm)<input type="number" min="0.1" step="0.1" value={station.maximum_length_cm} onChange={event=>updateStation("maximum_length_cm",event.target.value)}/></label></div>
     <div className="two"><label>Maximum width (cm)<input type="number" min="0.1" step="0.1" value={station.maximum_width_cm} onChange={event=>updateStation("maximum_width_cm",event.target.value)}/></label><label>Maximum height (cm)<input type="number" min="0.1" step="0.1" value={station.maximum_height_cm} onChange={event=>updateStation("maximum_height_cm",event.target.value)}/></label></div>
     <fieldset><legend>Station capability</legend><div className="interstate-checks">
      {categories.map(value=><label key={value}><input type="checkbox" checked={station.accepted_categories.includes(value)} onChange={()=>toggleList(setStation,"accepted_categories",value)}/>{value}</label>)}
      <label><input type="checkbox" checked={station.accepts_outgoing} onChange={event=>updateStation("accepts_outgoing",event.target.checked)}/>Accepts sender drop-offs</label>
      <label><input type="checkbox" checked={station.accepts_incoming} onChange={event=>updateStation("accepts_incoming",event.target.checked)}/>Accepts recipient collection</label>
     </div></fieldset>
     <div className="two"><label>Operational state<select value={station.operational_status} onChange={event=>updateStation("operational_status",event.target.value)}><option value="operational">Operational</option><option value="temporarily_closed">Temporarily closed</option><option value="suspended">Suspended</option></select></label><label className="terms-consent"><input type="checkbox" checked={station.active} onChange={event=>updateStation("active",event.target.checked)}/>Active station</label></div>
     <label>Collection instructions<textarea rows="3" maxLength="1000" value={station.collection_instructions||""} onChange={event=>updateStation("collection_instructions",event.target.value)}/></label>
     <button className="primary wide" disabled={busy==="station"}><Save size={16}/>{busy==="station"?"Saving…":"Save station"}</button>
    </form>
    <div className="interstate-admin-list"><h3>Station register <button type="button" className="ghost" onClick={()=>void load()}><RefreshCw size={14}/> Refresh</button></h3>
     {!stations.length?<p>No stations configured. Add only verified operating locations.</p>:stations.map(item=><article className="job interstate-register-item" key={item.id}>
      <div><b>{item.name}</b><small>{item.address}</small><small>{item.city}, {item.state} · {item.operational_status} · {item.active?"active":"inactive"}</small><small>{item.accepts_outgoing?"outgoing ":""}{item.accepts_incoming?"incoming":""} · {item.accepted_categories.join(", ")}</small></div>
      <button type="button" className="secondary" onClick={()=>editStation(item)}>Edit</button>
     </article>)}
    </div>
   </div>

   <div className="interstate-divider"/>
   <div className="interstate-admin-columns">
    <form className="form interstate-admin-form" onSubmit={saveRoute}>
     <div className="interstate-section-title"><h3>{route.id?"Edit route":"Configure a route"}</h3><button type="button" className="ghost" onClick={resetRoute}><Plus size={15}/> New</button></div>
     <label>Origin station<select required value={route.origin_station_id} onChange={event=>updateRoute("origin_station_id",event.target.value)}><option value="">Select station</option>{stationOptions.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
     <label>Destination station<select required value={route.destination_station_id} onChange={event=>updateRoute("destination_station_id",event.target.value)}><option value="">Select station</option>{stationOptions.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
     <label>Verified transport partner<input required maxLength="160" value={route.transport_partner} onChange={event=>updateRoute("transport_partner",event.target.value)}/></label>
     <div className="two"><label>Standard min days<input type="number" min="1" max="30" value={route.standard_min_days} onChange={event=>updateRoute("standard_min_days",event.target.value)}/></label><label>Standard max days<input type="number" min="1" max="30" value={route.standard_max_days} onChange={event=>updateRoute("standard_max_days",event.target.value)}/></label></div>
     <label className="terms-consent"><input type="checkbox" checked={route.express_available} onChange={event=>updateRoute("express_available",event.target.checked)}/>Express is operationally verified for this route</label>
     {route.express_available&&<div className="two"><label>Express min days<input type="number" min="1" max="4" value={route.express_min_days} onChange={event=>updateRoute("express_min_days",event.target.value)}/></label><label>Express max days<input type="number" min="1" max="4" value={route.express_max_days} onChange={event=>updateRoute("express_max_days",event.target.value)}/></label></div>}
     <div className="two"><label>Maximum weight (kg)<input type="number" min="0.1" step="0.1" value={route.maximum_weight_kg} onChange={event=>updateRoute("maximum_weight_kg",event.target.value)}/></label><label>Maximum route distance (km)<input type="number" min="0.1" step="0.1" value={route.maximum_distance_km} onChange={event=>updateRoute("maximum_distance_km",event.target.value)}/></label></div>
     <div className="two"><label>Departure cutoff<input type="time" value={route.departure_cutoff} onChange={event=>updateRoute("departure_cutoff",event.target.value)}/></label><span/></div>
     <fieldset><legend>Route capabilities</legend><div className="interstate-checks">{categories.map(value=><label key={value}><input type="checkbox" checked={route.supported_categories.includes(value)} onChange={()=>toggleList(setRoute,"supported_categories",value)}/>{value}</label>)}{vehicles.map(value=><label key={value}><input type="checkbox" checked={route.supported_vehicle_classes.includes(value)} onChange={()=>toggleList(setRoute,"supported_vehicle_classes",value)}/>{value}</label>)}</div></fieldset>
     <fieldset><legend>Operating days</legend><div className="interstate-checks">{days.map(day=><label key={day.id}><input type="checkbox" checked={route.operating_days.includes(day.id)} onChange={()=>toggleList(setRoute,"operating_days",day.id)}/>{day.label}</label>)}</div></fieldset>
     <label className="terms-consent"><input type="checkbox" checked={route.active} onChange={event=>updateRoute("active",event.target.checked)}/>Activate after verifying both stations and carrier capacity</label>
     <button className="primary wide" disabled={busy==="route"}><Save size={16}/>{busy==="route"?"Saving…":"Save route"}</button>
    </form>
    <div className="interstate-admin-list"><h3>Configured station routes</h3>{!routes.length?<p>No station routes configured.</p>:routes.map(item=>{
     const origin=stationById(item.origin_station_id),destination=stationById(item.destination_station_id);
     return <article className="job interstate-register-item" key={item.id}><div><b>{origin?.name||"Unknown station"} → {destination?.name||"Unknown station"}</b><small>{item.transport_partner} · {item.active?"active":"inactive"} · verified {item.last_verified_at?new Date(item.last_verified_at).toLocaleDateString():"not verified"}</small><small>Standard {item.standard_min_days}–{item.standard_max_days} days{item.express_available?` · Express ${item.express_min_days}–${item.express_max_days} days`:""}</small><small>{item.supported_categories.join(", ")} · {item.supported_vehicle_classes.join(", ")}</small></div><button type="button" className="secondary" onClick={()=>editRoute(item)}>Edit</button></article>
    })}</div>
   </div>

   <div className="interstate-divider"/>
   <div className="interstate-admin-columns">
    <form className="form interstate-admin-form" onSubmit={savePrice}>
     <div className="interstate-section-title"><h3>{price.id?`Edit draft · v${prices.find(item=>item.id===price.id)?.version||""}`:"Create a pricing revision"}</h3><button type="button" className="ghost" onClick={()=>{setPrice({...blankPrice});setPreview(null)}}><Plus size={15}/> New</button></div>
     <label>Journey type<select value={price.journey_type} onChange={event=>updatePrice("journey_type",event.target.value)}><option value="interstate">Interstate</option></select></label>
     <div className="two"><label>Package category<select value={price.package_category} onChange={event=>updatePrice("package_category",event.target.value)}>{["small","medium","bulky"].map(value=><option key={value}>{value}</option>)}</select></label><label>Vehicle class<select value={price.vehicle_class} onChange={event=>updatePrice("vehicle_class",event.target.value)}>{vehicles.map(value=><option key={value}>{value}</option>)}</select></label></div>
     <div className="two"><label>Base fare (₦)<input type="number" min="0" step="1" value={price.base_fare} onChange={event=>updatePrice("base_fare",event.target.value)}/></label><label>Minimum fare (₦)<input type="number" min="0" step="1" value={price.minimum_fare} onChange={event=>updatePrice("minimum_fare",event.target.value)}/></label></div>
     <label>Marginal distance bands (JSON)<textarea rows="7" value={price.distance_bands} onChange={event=>updatePrice("distance_bands",event.target.value)} placeholder='[{"up_to_km":100,"rate_per_km":300},{"up_to_km":null,"rate_per_km":200}]'/></label>
     <div className="two"><label>Maximum distance (km)<input type="number" min="0.1" step="0.1" value={price.maximum_distance_km} onChange={event=>updatePrice("maximum_distance_km",event.target.value)}/></label><label>Express premium (%)<input type="number" min="0" max="300" step="0.1" value={price.express_premium_percent} onChange={event=>updatePrice("express_premium_percent",event.target.value)}/></label></div>
     <label>Validated operating-cost floor (₦)<input type="number" min="0" step="1" value={price.operating_cost_floor} onChange={event=>updatePrice("operating_cost_floor",event.target.value)}/></label>
     <label>Operations note<input maxLength="1000" value={price.notes||""} onChange={event=>updatePrice("notes",event.target.value)}/></label>
     <button className="secondary wide" type="button" disabled={busy==="preview"} onClick={previewPrice}>Preview this rate</button>
     {preview&&<div className="notice"><b>{money(preview.price)} · {previewTier} · {previewDistance} km</b><small>Base {money(preview.breakdown.baseFare)} + marginal distance {money(preview.breakdown.distanceCharge)} + express {money(preview.breakdown.expressPremiumAmount)}. Cost floor {money(preview.breakdown.operatingCostFloor)}.</small></div>}
     <div className="two"><label>Test distance (km)<input type="number" min="0.1" step="0.1" value={previewDistance} onChange={event=>setPreviewDistance(event.target.value)}/></label><label>Test service<select value={previewTier} onChange={event=>setPreviewTier(event.target.value)}><option value="standard">Standard</option><option value="express">Express</option></select></label></div>
     <button className="primary wide" disabled={busy==="price"}><Save size={16}/>{busy==="price"?"Saving…":price.id?"Save draft":"Save new draft"}</button>
     <button className="secondary wide" type="button" disabled={!price.id||busy==="publish"} onClick={publishPrice}><CheckCircle2 size={16}/>{busy==="publish"?"Publishing…":"Publish validated version"}</button>
     <p className="package-safety">Publishing is blocked until the server validates band order and a positive cost floor. Drafts never affect local quotes. Existing local/same-state quotes remain unchanged.</p>
    </form>
    <div className="interstate-admin-list"><h3>Pricing version history</h3>{!prices.length?<p>No pricing versions found.</p>:prices.map(item=><article className="job interstate-register-item" key={item.id}><div><b>v{item.version} · {item.journey_type} · {item.package_category} · {item.vehicle_class}</b><small>{item.status} · floor {money(item.operating_cost_floor)} · base {money(item.base_fare)}</small><small>Distance bands: {item.distance_bands.map(band=>`${band.up_to_km??"∞"}km @ ${money(band.rate_per_km)}/km`).join(" · ")}</small></div><button className="secondary" type="button" onClick={()=>editPrice(item)}>{item.status==="draft"?"Edit draft":"Create revision"}</button></article>)}</div>
   </div>
   <p className="interstate-admin-footnote">{activePrices.length} published pricing rule{activePrices.length===1?"":"s"}. Interstate availability still requires an active verified route, operational stations and matching vehicle/category rules.</p>
  </section>

  <section className="panel interstate-order-operations">
   <div className="panel-head"><div><span className="eyebrow">STATE VERIFICATION & HANDOFF TRACKING</span><h2>Interstate bookings</h2></div><button className="secondary" onClick={()=>void load()}><RefreshCw size={15}/> Refresh</button></div>
   {!orders.length?<p>No interstate bookings yet.</p>:orders.map(order=>{
    const orderEvents=eventsFor(order);
    const next=nextStage(order);
    const station=order.destination_station_snapshot;
    return <article className="job interstate-booking-admin" key={order.id}>
     <div className="order-top"><b>{order.tracking_number}</b><strong>{order.status} · {order.payment_status}</strong></div>
     <p><b>Sender:</b> {order.pickup_address}</p><p><b>State:</b> {order.pickup_state} · {order.pickup_state_status}</p>
     <p><b>Collection:</b> {station?.name} · {station?.address}, {station?.city}, {station?.state}</p>
     <p><b>Carrier:</b> {order.interstate_route_snapshot?.transport_partner||"not set"} · {order.estimated_delivery_min_days}–{order.estimated_delivery_max_days} days</p>
     {order.pickup_state_status!=="verified"&&<div className="interstate-review-form">
      <label>State review / audit note<textarea minLength="3" maxLength="1000" value={pickupNote[order.id]||""} onChange={event=>setPickupNote(current=>({...current,[order.id]:event.target.value}))} placeholder="Record how the sender's stated pickup state was checked."/></label>
      <div className="actions"><button className="primary" disabled={busy===`verify:${order.id}`} onClick={()=>verifyPickup(order,true)}>Verify pickup state</button><button className="secondary" disabled={busy===`verify:${order.id}`} onClick={()=>verifyPickup(order,false)}>Reject / request correction</button></div>
     </div>}
     {order.payment_status==="paid"&&order.pickup_state_status==="verified"&&<div className="interstate-stage-list">
      <h4>Shipment milestones</h4>
      {orderEvents.filter(item=>stages.some(stage=>stage.id===item.event)).map(item=><p className="interstate-stage-event" key={item.id}><CheckCircle2 size={15}/><span><b>{stages.find(stage=>stage.id===item.event)?.label}</b><small>{new Date(item.created_at).toLocaleString()} · {item.note||"Recorded by operations / dispatch"}</small></span></p>)}
      {next&&<div className="interstate-review-form"><b>Next: {next.label}</b><label>Handoff / collection confirmation<textarea minLength="5" maxLength="1000" value={shipmentNote[order.id]||""} onChange={event=>setShipmentNote(current=>({...current,[order.id]:event.target.value}))} placeholder="Record who confirmed the handoff or collection and any reference."/></label><button className="primary" disabled={busy===`stage:${order.id}`} onClick={()=>recordShipmentStage(order,next.id)}>{next.id==="recipient_collected"?"Confirm recipient collection":"Record milestone"}</button></div>}
      {!next&&<p>Waiting for the next dispatch event or for the preceding milestone to be confirmed.</p>}
     </div>}
    </article>
   })}
  </section>
 </main>;
}
