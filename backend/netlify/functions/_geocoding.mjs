let requestQueue=Promise.resolve();
let lastRequestAt=0;

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

function formatNominatimAddress(item,lat,lng){
 const parts=item.address||{},street=[parts.house_number,parts.road].filter(Boolean).join(" "),title=item.name||parts.amenity||parts.shop||parts.tourism||parts.leisure||parts.building||street||parts.neighbourhood||parts.suburb||parts.village||parts.town||parts.city||parts.county;
 const locality=[street,parts.neighbourhood,parts.suburb,parts.village,parts.town,parts.city,parts.state,parts.country].filter((part,index,all)=>part&&all.indexOf(part)===index&&part!==title);
 const address=[title,...locality].filter(Boolean).join(", ");
 return address?{title:title||"Selected location",details:locality.join(", "),address,lat,lng}:null;
}

function formatPhotonAddress(collection,lat,lng){
 const feature=collection.features?.find(item=>item.properties);
 if(!feature)return null;
 const properties=feature.properties,street=[properties.housenumber,properties.street].filter(Boolean).join(" "),title=properties.name||street||properties.district||properties.locality||properties.city||properties.county||properties.state;
 const locality=[street,properties.district,properties.locality,properties.city,properties.county,properties.state,properties.country].filter((part,index,all)=>part&&all.indexOf(part)===index&&part!==title);
 const address=[title,...locality].filter(Boolean).join(", ");
 return address?{title:title||"Selected location",details:locality.join(", "),address,lat,lng}:null;
}

export async function reverseGeocode(lat,lng){
 if(lat===null||lat===undefined||lat===""||lng===null||lng===undefined||lng===""||!Number.isFinite(Number(lat))||Number(lat)<-90||Number(lat)>90||!Number.isFinite(Number(lng))||Number(lng)<-180||Number(lng)>180)throw new Error("A valid map location is required.");
 lat=Number(lat);
 lng=Number(lng);

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
