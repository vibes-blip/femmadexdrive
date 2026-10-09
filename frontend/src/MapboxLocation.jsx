import React,{useEffect,useId,useRef,useState} from "react";
import * as maplibregl from "maplibre-gl";
import {Clock3,LocateFixed,MapPin,Navigation,Search,X} from "lucide-react";
import {apiUrl} from "./api.js";

const OSM_STYLE={
 version:8,
 sources:{
  openstreetmap:{
   type:"raster",
   tiles:[
    "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
    "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
    "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png"
   ],
   tileSize:256,
   attribution:"© <a href='https://www.openstreetmap.org/copyright' target='_blank' rel='noopener noreferrer'>OpenStreetMap contributors</a>"
  }
 },
 layers:[{id:"openstreetmap-raster",type:"raster",source:"openstreetmap"}]
};
const validPoint=(lat,lng)=>lat!==null&&lat!==undefined&&lat!==""&&lng!==null&&lng!==undefined&&lng!==""&&Number.isFinite(Number(lat))&&Number(lat)>=-90&&Number(lat)<=90&&Number.isFinite(Number(lng))&&Number(lng)>=-180&&Number(lng)<=180;
export function locationUnavailableMessage(){
 if(typeof window!=="undefined"&&!window.isSecureContext)return "Browser location requires a secure HTTPS connection. Enter an address or choose a location on the map instead.";
 if(typeof navigator==="undefined"||!navigator.geolocation)return "Location is not available in this browser. Enter an address or choose a location on the map instead.";
 return "";
}

export function geolocationErrorMessage(error,fallback){
 if(error?.code===1)return `Location permission was denied. ${fallback}`;
 if(error?.code===2)return `Your location could not be determined. Check your device's location settings or ${fallback.toLowerCase()}`;
 if(error?.code===3)return `Finding your location timed out. Try again or ${fallback.toLowerCase()}`;
 return `Could not get your location. ${fallback}`;
}

async function geocodingRequest(path,params,signal){
 const endpoint=new URL(apiUrl(path),window.location.href);
 for(const [name,value] of Object.entries(params))endpoint.searchParams.set(name,String(value));
 const response=await fetch(endpoint,{signal,headers:{"Accept-Language":"en"}});
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(data.error||"Address lookup is temporarily unavailable.");
 return data;
}

export async function searchAddresses(query,{proximity,signal}={}){
 const center=proximity||{lng:3.3792,lat:6.5244};
 const data=await geocodingRequest("address-search",{q:query,lat:center.lat,lng:center.lng},signal);
 return (Array.isArray(data.results)?data.results:[]).flatMap(item=>{
  const lat=Number(item.lat),lng=Number(item.lng),address=item.address?.trim();
  return validPoint(lat,lng)&&address?[{...item,address,title:item.title||address,details:item.details||address,lat,lng}]:[];
 });
}

export async function reverseGeocode(lat,lng,signal){
 if(!validPoint(lat,lng))throw new Error("Select a valid location on the map.");
 const result=await geocodingRequest("reverse-geocode",{lat:Number(lat),lng:Number(lng)},signal);
 const address=result.address?.trim();
 if(!address)throw new Error("No readable address could be verified at this point. Move the pin to a nearby street or landmark.");
 return {...result,address,title:result.title||address,lat:Number(lat),lng:Number(lng)};
}

function useRecentLocations(){
 return useState(()=>{
  try{
   const stored=JSON.parse(localStorage.getItem("fdd-recent-locations")||"[]");
   return Array.isArray(stored)?stored.filter(item=>item?.address&&validPoint(Number(item.lat),Number(item.lng))):[];
  }catch{
   return [];
  }
 });
}

export function Address({label,value,onChange,onSelect,coordinates,locate,locating}){
 const inputId=useId();
 const [results,setResults]=useState([]);
 const [recent,setRecent]=useRecentLocations();
 const [near,setNear]=useState(null);
 const [searching,setSearching]=useState(false);
 const [nearbyBusy,setNearbyBusy]=useState(false);
 const [selecting,setSelecting]=useState(false);
 const [focused,setFocused]=useState(false);
 const [error,setError]=useState("");
 const [mapOpen,setMapOpen]=useState(false);

 useEffect(()=>{
  const query=value.trim();
  if((query&&query.length<3)||(!query&&!near)){
   setResults([]);
   setError("");
   setSearching(false);
   return;
  }
  const controller=new AbortController();
  let current=true;
  const timer=setTimeout(async()=>{
   setSearching(true);
   setError("");
   try{
    const matches=query
     ?await searchAddresses(query,{proximity:near,signal:controller.signal})
     :[await reverseGeocode(near.lat,near.lng,controller.signal)];
    if(current)setResults(matches);
   }catch(requestError){
    if(current&&requestError.name!=="AbortError"){
     setResults([]);
     setError(requestError.message);
    }
   }finally{
    if(current)setSearching(false);
   }
  },1100);
  return()=>{
   current=false;
   clearTimeout(timer);
   controller.abort();
  };
 },[value,near]);

 const choose=async point=>{
  setSelecting(true);
  setError("");
  try{
   const selected=await reverseGeocode(point.lat,point.lng);
   onSelect(selected.address,{lat:selected.lat,lng:selected.lng});
   setRecent(current=>{
    const next=[selected,...current.filter(item=>item.address!==selected.address)].slice(0,6);
    try{localStorage.setItem("fdd-recent-locations",JSON.stringify(next))}catch{}
    return next;
   });
   setResults([]);
   setFocused(false);
   return true;
  }catch(selectionError){
   setError(selectionError.message);
   return false;
  }finally{
   setSelecting(false);
  }
 };

 const searchNearby=()=>{
  const unavailable=locationUnavailableMessage();
  if(unavailable){setError(unavailable);return}
  setNearbyBusy(true);
  setError("");
  navigator.geolocation.getCurrentPosition(position=>{
   setNear({lat:position.coords.latitude,lng:position.coords.longitude});
   setNearbyBusy(false);
   setFocused(true);
  },error=>{
   setNearbyBusy(false);
   setError(geolocationErrorMessage(error,"You can still type an address or choose it on the map."));
  },{enableHighAccuracy:true,timeout:12000});
 };

 return <>
  <div className="address-field">
   <label htmlFor={inputId}>{label}</label>
   <div className="address"><MapPin size={17}/>
    <input id={inputId} required value={value} onFocus={()=>setFocused(true)} onBlur={()=>setTimeout(()=>setFocused(false),160)} onChange={event=>onChange(event.target.value)} placeholder="Type a street, place or landmark"/>
    <button type="button" aria-label="Use current location" onClick={locate}>{locating?<span className="spinner small"/>:<LocateFixed size={16}/>}</button>
    <button type="button" aria-label="Choose location on map" onClick={()=>setMapOpen(true)}><Navigation size={16}/></button>
   </div>
   <div className="address-tools"><button type="button" onClick={searchNearby} disabled={nearbyBusy}>{nearbyBusy?<span className="spinner small"/>:<Search size={13}/>} Search near me</button>{near&&<button type="button" onClick={()=>setNear(null)}>Clear nearby filter</button>}</div>
   {selecting&&<small className="address-hint">Verifying address with OpenStreetMap…</small>}
   {near&&<small className="address-hint">Showing nearby matches first{value.trim()?" for your search":""}.</small>}
   {searching&&<small className="address-hint">Searching real addresses…</small>}
   {error&&<small className="address-error" role="alert">{error}</small>}
   {focused&&results.length>0&&<><div className="address-suggestions" role="listbox" aria-label="Matching addresses">{results.map((point,index)=><button key={`${point.lat}-${point.lng}-${index}`} type="button" role="option" disabled={selecting} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(point)}><MapPin size={15}/><span><b>{point.title}</b><small>{point.details}</small></span></button>)}</div><small className="address-attribution">Address data © <a href='https://www.openstreetmap.org/copyright' target='_blank' rel='noopener noreferrer'>OpenStreetMap contributors</a></small></>}
   {focused&&!searching&&!error&&value.trim().length>=3&&results.length===0&&<small className="address-hint">No matching addresses. Try a street, landmark, nearby search, or choose on the map.</small>}
   {focused&&!value.trim()&&!near&&recent.length>0&&<div className="address-suggestions recent-locations" role="listbox" aria-label="Recent locations"><small>Recent locations</small>{recent.map((point,index)=><button key={`${point.lat}-${point.lng}-${index}`} type="button" role="option" onMouseDown={event=>event.preventDefault()} onClick={()=>choose(point)}><Clock3 size={15}/><span><b>{point.title||point.address}</b><small>{point.address}</small></span></button>)}</div>}
   {focused&&!value.trim()&&!near&&recent.length===0&&<small className="address-hint">Type to search addresses, choose a recent location, or search near you.</small>}
  </div>
  {mapOpen&&<LocationPicker initialCoordinates={coordinates} onClose={()=>setMapOpen(false)} onSelect={choose}/>}
 </>;
}

function LocationPicker({initialCoordinates,onClose,onSelect}){
 const container=useRef(null);
 const map=useRef(null);
 const marker=useRef(null);
 const [query,setQuery]=useState("");
 const [results,setResults]=useState([]);
 const [loading,setLoading]=useState(false);
 const [searching,setSearching]=useState(false);
 const [hasSelection,setHasSelection]=useState(Boolean(initialCoordinates&&validPoint(initialCoordinates.lat,initialCoordinates.lng)));
 const [selectedAddress,setSelectedAddress]=useState("");
 const [error,setError]=useState("");

 useEffect(()=>{
  if(!container.current)return;
  let instance;
  try{
   instance=new maplibregl.Map({
    container:container.current,
    style:OSM_STYLE,
    center:initialCoordinates&&validPoint(initialCoordinates.lat,initialCoordinates.lng)?[initialCoordinates.lng,initialCoordinates.lat]:[3.3792,6.5244],
    zoom:initialCoordinates&&validPoint(initialCoordinates.lat,initialCoordinates.lng)?15:10,
    attributionControl:true
   });
   map.current=instance;
   instance.addControl(new maplibregl.NavigationControl({showCompass:true}),"top-right");
   instance.on("load",()=>{
    if(initialCoordinates&&validPoint(initialCoordinates.lat,initialCoordinates.lng)){
     marker.current=new maplibregl.Marker({color:"#6d28d9",draggable:true})
      .setLngLat([initialCoordinates.lng,initialCoordinates.lat])
      .addTo(instance);
     marker.current.on("dragend",()=>setHasSelection(true));
    }
   });
   instance.on("click",event=>{
    const point={lat:event.lngLat.lat,lng:event.lngLat.lng};
    if(marker.current)marker.current.setLngLat([point.lng,point.lat]);
    else{
     marker.current=new maplibregl.Marker({color:"#6d28d9",draggable:true})
      .setLngLat([point.lng,point.lat])
      .addTo(instance);
     marker.current.on("dragend",()=>setHasSelection(true));
    }
    setHasSelection(true);
    setSelectedAddress("");
    setError("");
   });
   instance.on("error",event=>{
    if(event.error)setError("OpenStreetMap tiles could not be loaded. Check your internet connection.");
   });
  }catch(mapError){
   setError(mapError.message||"The map could not be opened.");
  }
  return()=>{
   map.current=null;
   marker.current=null;
   instance?.remove();
  };
 },[initialCoordinates]);

 useEffect(()=>{
  const text=query.trim();
  if(text.length<3){setResults([]);setSearching(false);return}
  const controller=new AbortController();
  let current=true;
  const timer=setTimeout(async()=>{
   setSearching(true);
   setError("");
   try{
    const matches=await searchAddresses(text,{signal:controller.signal});
    if(current)setResults(matches);
   }catch(searchError){
    if(current&&searchError.name!=="AbortError"){setResults([]);setError(searchError.message)}
   }finally{
    if(current)setSearching(false);
   }
  },1100);
  return()=>{
   current=false;
   clearTimeout(timer);
   controller.abort();
  };
 },[query]);

 const placeMarker=(point,address)=>{
  if(!map.current||!validPoint(point.lat,point.lng))return;
  map.current.flyTo({center:[point.lng,point.lat],zoom:16});
  if(marker.current)marker.current.setLngLat([point.lng,point.lat]);
  else{
   marker.current=new maplibregl.Marker({color:"#6d28d9",draggable:true})
    .setLngLat([point.lng,point.lat])
    .addTo(map.current);
   marker.current.on("dragend",()=>{setHasSelection(true);setSelectedAddress("")});
  }
  setHasSelection(true);
  setSelectedAddress(address||"");
  setResults([]);
  setError("");
 };

 const useCurrentLocation=()=>{
  const unavailable=locationUnavailableMessage();
  if(unavailable){setError(unavailable);return}
  setLoading(true);
  navigator.geolocation.getCurrentPosition(position=>{
   placeMarker({lat:position.coords.latitude,lng:position.coords.longitude});
   setLoading(false);
  },error=>{
   setLoading(false);
   setError(geolocationErrorMessage(error,"Search or select a point on the map instead."));
  },{enableHighAccuracy:true,timeout:12000});
 };

 const confirm=async()=>{
  const point=marker.current?.getLngLat();
  if(!hasSelection||!point){setError("Search for an address or select a point on the map first.");return}
  setLoading(true);
  setError("");
  try{
   const verified=await onSelect({lat:point.lat,lng:point.lng});
   if(verified===false)return;
   onClose();
  }catch(selectionError){
   setError(selectionError.message);
  }finally{
   setLoading(false);
  }
 };

 return <div className="modal map-modal" onClick={onClose}>
  <section className="map-card osm-map-card" onClick={event=>event.stopPropagation()}>
   <div className="map-heading"><div><b>Choose a location</b><small>Search for an address or click and move the pin to the exact point.</small></div><button className="close" onClick={onClose} aria-label="Close map"><X/></button></div>
   <div className="osm-map-search"><div className="search"><input aria-label="Search map addresses" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search streets, places or landmarks"/><button type="button" className="secondary" onClick={useCurrentLocation} disabled={loading}><LocateFixed size={16}/> My location</button></div>   {searching&&<small className="address-hint">Searching OpenStreetMap…</small>}{query.trim().length>=3&&!searching&&!error&&results.length===0&&<small className="address-hint">No matching addresses found.</small>}{results.length>0&&<div className="address-suggestions osm-map-results" role="listbox" aria-label="Map search results">{results.map(point=><button key={`${point.lat}-${point.lng}`} type="button" role="option" onClick={()=>placeMarker(point,point.address)}><MapPin size={15}/><span><b>{point.title}</b><small>{point.address}</small></span></button>)}</div>}</div>
   <div className="osm-map-canvas" ref={container} aria-label="Interactive OpenStreetMap location map"/>
   {selectedAddress&&<p className="map-selected-address"><MapPin size={15}/>{selectedAddress}</p>}
   {error&&<div className="address-error" role="alert">{error}</div>}
   {!hasSelection&&<small className="address-hint">No location is selected yet. Choose a search result or click the map.</small>}
   <div className="map-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={loading||!hasSelection} onClick={confirm}>{loading?"Verifying address…":"Use this location"}</button></div>
  </section>
 </div>;
}

export function DeliveryLocationMap({order,riderLocation,onClose}){
 const container=useRef(null);
 const [error,setError]=useState("");
 useEffect(()=>{
  if(!validPoint(order.pickup_latitude,order.pickup_longitude)||!validPoint(order.dropoff_latitude,order.dropoff_longitude)){setError("This delivery has no verified pickup and delivery coordinates.");return}
  const pickup={lat:Number(order.pickup_latitude),lng:Number(order.pickup_longitude)};
  const delivery={lat:Number(order.dropoff_latitude),lng:Number(order.dropoff_longitude)};
  if(!container.current)return;
  let instance;
  try{
   instance=new maplibregl.Map({container:container.current,style:OSM_STYLE,center:[delivery.lng,delivery.lat],zoom:12});
   instance.addControl(new maplibregl.NavigationControl({showCompass:true}),"top-right");
   instance.on("load",()=>{
    const points=[
     {point:pickup,label:`Pickup: ${order.pickup_address}`,color:"#2563eb"},
     {point:delivery,label:`Customer delivery: ${order.dropoff_address}`,color:"#6d28d9"}
    ];
    if(riderLocation&&validPoint(riderLocation.lat,riderLocation.lng)){
     points.push({point:{lat:Number(riderLocation.lat),lng:Number(riderLocation.lng)},label:"Your last shared rider location",color:"#16a34a"});
    }
    const bounds=new maplibregl.LngLatBounds();
    for(const item of points){
     const coordinates=[item.point.lng,item.point.lat];
     bounds.extend(coordinates);
     new maplibregl.Marker({color:item.color}).setLngLat(coordinates).setPopup(new maplibregl.Popup({offset:24}).setText(item.label)).addTo(instance);
    }
    instance.fitBounds(bounds,{padding:60,maxZoom:15});
   });
   instance.on("error",event=>{if(event.error)setError("OpenStreetMap tiles could not be loaded. Check your internet connection.")});
  }catch(mapError){
   setError(mapError.message||"The delivery map could not be opened.");
  }
  return()=>instance?.remove();
 },[order,riderLocation]);

 return <div className="modal map-modal" onClick={onClose}>
  <section className="map-card osm-map-card" onClick={event=>event.stopPropagation()}>
   <div className="map-heading"><div><b>Delivery locations</b><small>Map uses the verified coordinates saved for this assigned delivery.</small></div><button className="close" onClick={onClose} aria-label="Close map"><X/></button></div>
   {error&&<div className="address-error" role="alert">{error}</div>}
   <div className="osm-map-canvas delivery-map-canvas" ref={container} aria-label="Map showing delivery locations"/>
   <p className="map-selected-address"><MapPin size={15}/>{order.dropoff_address}</p>
   <div className="map-actions"><button className="secondary" onClick={onClose}>Close</button><NavigationLink label="Navigate to customer" lat={order.dropoff_latitude} lng={order.dropoff_longitude}/></div>
  </section>
 </div>;
}

export function NavigationLink({label,lat,lng}){
 if(!validPoint(lat,lng))return null;
 const latitude=Number(lat),longitude=Number(lng);
 const href=`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${latitude},${longitude}`)}&travelmode=driving`;
 return <a className="primary navigation-link" href={href} target="_blank" rel="noreferrer"><Navigation size={15}/>{label}</a>;
}
