import {fetchGeocoding,reverseGeocode} from "./_geocoding.mjs";
import {corsHeaders} from "./_lib.mjs";

const headers={"Content-Type":"application/json",...corsHeaders("GET, OPTIONS")};
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
const validPoint=(lat,lng)=>Number.isFinite(lat)&&lat>=-90&&lat<=90&&Number.isFinite(lng)&&lng>=-180&&lng<=180;
const formatAddress=properties=>{
 const street=[properties.housenumber,properties.street].filter(Boolean).join(" ");
 const title=properties.name||street||properties.district||properties.locality||properties.city||properties.county||properties.state;
 const context=[street,properties.district,properties.locality,properties.city,properties.county,properties.state,properties.country].filter((part,index,all)=>part&&all.indexOf(part)===index&&part!==title);
 const address=[title,...context].filter(Boolean).join(", ");
 return {title:title||"Selected location",address,details:context.join(", ")};
};
export default async req=>{
 if(req.method==="OPTIONS")return new Response("",{status:204,headers});
 const params=new URL(req.url).searchParams,query=(params.get("q")||"").trim().slice(0,180),rawLat=params.get("lat"),rawLng=params.get("lng"),lat=rawLat===null?NaN:Number(rawLat),lng=rawLng===null?NaN:Number(rawLng),near=rawLat!==null&&rawLng!==null&&rawLat.trim()!==""&&rawLng.trim()!==""&&validPoint(lat,lng);

 if(!query&&!near)return reply({results:[]});
 try{
  if(!query){
   const result=await reverseGeocode(lat,lng);
   return reply({results:[result]});
  }
  const search=new URL("https://photon.komoot.io/api/");
  search.searchParams.set("limit","8");search.searchParams.set("q",query);
  if(near){search.searchParams.set("lat",String(lat));search.searchParams.set("lon",String(lng))}
  const response=await fetch(search);
  if(!response.ok)return reply({error:"Address search is temporarily unavailable."},502);
  const collection=await response.json();
  const results=(collection.features||[]).map(feature=>{const [resultLng,resultLat]=feature.geometry?.coordinates||[],point={lat:Number(resultLat),lng:Number(resultLng)};return {...formatAddress(feature.properties||{}),...point}}).filter(item=>item.address&&validPoint(item.lat,item.lng));
  return reply({results});
 }catch(error){
  console.error("Address search failed",error);
  return reply({error:"Address search is temporarily unavailable."},502);
 }
};
