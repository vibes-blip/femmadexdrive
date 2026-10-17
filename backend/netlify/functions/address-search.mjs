import {formatGeoapifyAddress,reverseGeocode} from "./_geocoding.mjs";
import {corsHeaders} from "./_lib.mjs";

const headers={"Content-Type":"application/json",...corsHeaders("GET, OPTIONS")};
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
const validPoint=(lat,lng)=>Number.isFinite(lat)&&lat>=-90&&lat<=90&&Number.isFinite(lng)&&lng>=-180&&lng<=180;
export const formatAddress=properties=>{
 const street=[properties.housenumber,properties.street].filter(Boolean).join(" ");
 const title=properties.housenumber?street:properties.name||street||properties.district||properties.locality||properties.city||properties.county||properties.state;
 const context=[street,properties.district,properties.locality,properties.city,properties.county,properties.state,properties.country].filter((part,index,all)=>part&&all.indexOf(part)===index&&part!==title);
 const address=[title,...context].filter(Boolean).join(", ");
 return {title:title||"Selected location",address,details:context.join(", "),provider:"Photon",resultType:properties.type||properties.osm_value||null,houseNumber:properties.housenumber||null,precision:properties.housenumber?"building":properties.street?"street":"place"};
};
const geoapifyResults=collection=>(collection.results||collection.features||[])
 .map(item=>formatGeoapifyAddress(item))
 .filter(Boolean);
const prioritizeHouseNumber=(results,query)=>{
 const number=query.match(/^\s*(\d+[a-z]?(?:[-/]\d+[a-z]?)?)(?=\s|,)/i)?.[1]?.toLowerCase();
 if(!number)return results;
 return [...results].sort((left,right)=>Number(String(right.houseNumber||"").toLowerCase()===number)-Number(String(left.houseNumber||"").toLowerCase()===number));
};

async function searchGeoapify(query,lat,lng,near){
 const apiKey=process.env.GEOAPIFY_API_KEY;
 if(!apiKey)return null;
 const search=new URL("https://api.geoapify.com/v1/geocode/autocomplete");
 search.searchParams.set("limit","8");
 search.searchParams.set("text",query);
 search.searchParams.set("format","json");
 search.searchParams.set("lang","en");
 search.searchParams.set("bias",`proximity:${lng},${lat}`);
 search.searchParams.set("apiKey",apiKey);
 const response=await fetch(search,{signal:AbortSignal.timeout(8000),headers:{"Accept-Language":"en"}});
 if(!response.ok){
  console.warn("Geoapify address search returned an unsuccessful response",{status:response.status});
  return null;
 }
 return prioritizeHouseNumber(geoapifyResults(await response.json()),query);
}

async function searchPhoton(query,lat,lng,near){
 const search=new URL("https://photon.komoot.io/api/");
 search.searchParams.set("limit","8");
 search.searchParams.set("q",query);
 if(near){search.searchParams.set("lat",String(lat));search.searchParams.set("lon",String(lng))}
 const response=await fetch(search,{signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw new Error(`Photon address search returned ${response.status}.`);
 const collection=await response.json();
 return (collection.features||[]).map(feature=>{
  const [resultLng,resultLat]=feature.geometry?.coordinates||[];
  const point={lat:Number(resultLat),lng:Number(resultLng)};
  return {...formatAddress(feature.properties||{}),...point};
 }).filter(item=>item.address&&validPoint(item.lat,item.lng));
}

export default async req=>{
 if(req.method==="OPTIONS")return new Response("",{status:204,headers});
 const params=new URL(req.url).searchParams,query=(params.get("q")||"").trim().slice(0,180),rawLat=params.get("lat"),rawLng=params.get("lng"),lat=rawLat===null?NaN:Number(rawLat),lng=rawLng===null?NaN:Number(rawLng),near=rawLat!==null&&rawLng!==null&&rawLat.trim()!==""&&rawLng.trim()!==""&&validPoint(lat,lng);

 if(!query&&!near)return reply({results:[]});
 try{
  if(!query){
   const result=await reverseGeocode(lat,lng);
   return reply({results:[result]});
  }
  let results=null;
  try{results=await searchGeoapify(query,lat,lng,near)}
  catch(error){console.warn("Geoapify address search failed; trying Photon",error.message)}
  if(!results?.length)results=await searchPhoton(query,lat,lng,near);
  return reply({results});
 }catch(error){
  console.error("Address search failed",error.message);
  return reply({error:"Address search is temporarily unavailable."},502);
 }
};
