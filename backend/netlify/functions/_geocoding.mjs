let requestQueue=Promise.resolve();
let lastRequestAt=0;

function geoapifyApiKey(){
 return process.env.GEOAPIFY_API_KEY||"";
}

async function fetchGeoapify(url){
 return fetch(url,{signal:AbortSignal.timeout(8000),headers:{"Accept-Language":"en"}});
}

export function fetchGeocoding(url){
 const request=requestQueue.then(async()=>{
  const delay=Math.max(0,1100-(Date.now()-lastRequestAt));
  if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
  lastRequestAt=Date.now();
  return fetch(url,{headers:{"User-Agent":"FemmaDexDrive/2.2 contact:femmadexmanagement@gmail.com","Accept-Language":"en"}});
 });
 requestQueue=request.then(()=>undefined,()=>undefined);
 return request;
}

export function formatGeoapifyAddress(item,latOverride,lngOverride){
 const properties=item?.properties||item||{};
 const latitude=Number(latOverride??properties.lat??item?.geometry?.coordinates?.[1]);
 const longitude=Number(lngOverride??properties.lon??properties.lng??item?.geometry?.coordinates?.[0]);
 if(!Number.isFinite(latitude)||latitude < -90||latitude>90||!Number.isFinite(longitude)||longitude < -180||longitude>180)return null;
 const houseNumber=String(properties.housenumber||properties.house_number||"").trim()||null;
 const street=String(properties.street||"").trim();
 const streetAddress=String(properties.address_line1||[houseNumber,street].filter(Boolean).join(" ")).trim();
 const context=[properties.suburb,properties.district,properties.city,properties.county,properties.state,properties.country]
  .map(part=>String(part||"").trim()).filter((part,index,all)=>part&&all.indexOf(part)===index);
 const title=houseNumber&&street?[houseNumber,street].join(" "):String(properties.name||streetAddress||street||properties.suburb||properties.city||properties.state||"").trim();
 const address=String(properties.formatted||[title,...context].filter(Boolean).join(", ")).trim();
 if(!address)return null;
 const details=String(properties.address_line2||context.filter(part=>!title.includes(part)).join(", ")).trim();
 return {
  title:title||address,
  address,
  details,
  lat:latitude,
  lng:longitude,
  provider:"Geoapify",
  resultType:properties.result_type||properties.type||null,
  state:String(properties.state||"").trim()||null,
  country:String(properties.country||"").trim()||null,
  countryCode:String(properties.country_code||"").trim().toLowerCase()||null,
  houseNumber,
  precision:houseNumber?"building":street?"street":"place"
 };
}

function formatNominatimAddress(item,lat,lng){
 const parts=item.address||{},street=[parts.house_number,parts.road].filter(Boolean).join(" "),title=parts.house_number&&parts.road?street:item.name||parts.amenity||parts.shop||parts.tourism||parts.leisure||parts.building||street||parts.neighbourhood||parts.suburb||parts.village||parts.town||parts.city||parts.county;
 const locality=[street,parts.neighbourhood,parts.suburb,parts.village,parts.town,parts.city,parts.state,parts.country].filter((part,index,all)=>part&&all.indexOf(part)===index&&part!==title);
 const address=[title,...locality].filter(Boolean).join(", ");
 return address?{title:title||"Selected location",details:locality.join(", "),address,lat,lng,provider:"Nominatim",resultType:item.addresstype||null,state:String(parts.state||"").trim()||null,country:String(parts.country||"").trim()||null,countryCode:String(parts.country_code||"").trim().toLowerCase()||null,houseNumber:parts.house_number||null,precision:parts.house_number?"building":parts.road?"street":"place"}:null;
}

function formatPhotonAddress(collection,lat,lng){
 const feature=collection.features?.find(item=>item.properties);
 if(!feature)return null;
 const properties=feature.properties,street=[properties.housenumber,properties.street].filter(Boolean).join(" "),title=properties.housenumber?street:properties.name||street||properties.district||properties.locality||properties.city||properties.county||properties.state;
 const locality=[street,properties.district,properties.locality,properties.city,properties.county,properties.state,properties.country].filter((part,index,all)=>part&&all.indexOf(part)===index&&part!==title);
 const address=[title,...locality].filter(Boolean).join(", ");
 return address?{title:title||"Selected location",details:locality.join(", "),address,lat,lng,provider:"Photon",resultType:properties.type||properties.osm_value||null,state:String(properties.state||"").trim()||null,country:String(properties.country||"").trim()||null,countryCode:String(properties.countrycode||"").trim().toLowerCase()||null,houseNumber:properties.housenumber||null,precision:properties.housenumber?"building":properties.street?"street":"place"}:null;
}

export async function reverseGeocode(lat,lng){
 if(lat===null||lat===undefined||lat===""||lng===null||lng===undefined||lng===""||!Number.isFinite(Number(lat))||Number(lat)<-90||Number(lat)>90||!Number.isFinite(Number(lng))||Number(lng)<-180||Number(lng)>180)throw new Error("A valid map location is required.");
 lat=Number(lat);
 lng=Number(lng);

 const apiKey=geoapifyApiKey();
 if(apiKey){
  const endpoint=new URL("https://api.geoapify.com/v1/geocode/reverse");
  endpoint.searchParams.set("lat",String(lat));
  endpoint.searchParams.set("lon",String(lng));
  endpoint.searchParams.set("format","json");
  endpoint.searchParams.set("lang","en");
  endpoint.searchParams.set("apiKey",apiKey);
  try{
   const response=await fetchGeoapify(endpoint);
   if(response.ok){
    const collection=await response.json();
    const candidate=collection.results?.[0]||collection.features?.[0];
    const result=formatGeoapifyAddress(candidate,lat,lng);
    if(result)return result;
   }else{
    console.warn("Geoapify reverse geocoding returned an unsuccessful response",{status:response.status});
   }
  }catch(error){
   console.warn("Geoapify reverse geocoding failed; trying OpenStreetMap providers",error.message);
  }
 }

 const endpoint=new URL("https://nominatim.openstreetmap.org/reverse");
 endpoint.searchParams.set("format","jsonv2");
 endpoint.searchParams.set("lat",String(lat));
 endpoint.searchParams.set("lon",String(lng));
 endpoint.searchParams.set("zoom","18");
 endpoint.searchParams.set("addressdetails","1");
 endpoint.searchParams.set("accept-language","en");
 try{
  const response=await fetchGeocoding(endpoint);
  if(response.ok){
   const result=formatNominatimAddress(await response.json(),lat,lng);
   if(result)return result;
  }else{
   console.warn("Nominatim reverse geocoding returned an unsuccessful response",{status:response.status});
  }
 }catch(error){
  console.warn("Nominatim reverse geocoding failed; trying Photon",error.message);
 }

 const fallback=new URL("https://photon.komoot.io/reverse");
 fallback.searchParams.set("lat",String(lat));
 fallback.searchParams.set("lon",String(lng));
 const response=await fetchGeocoding(fallback);
 if(!response.ok){
  console.error("Photon reverse geocoding returned an unsuccessful response",{status:response.status});
  throw new Error("Address lookup is temporarily unavailable.");
 }
 const result=formatPhotonAddress(await response.json(),lat,lng);
 if(!result)throw new Error("No readable street or place name was found for this point. Move the pin to a nearby road or landmark.");
 return result;
}
