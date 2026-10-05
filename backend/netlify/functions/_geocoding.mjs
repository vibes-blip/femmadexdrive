let requestQueue=Promise.resolve();
let lastRequestAt=0;
const mapboxToken=(process.env.MAPBOX_ACCESS_TOKEN||"").trim();

export function fetchGeocoding(url){
 const request=requestQueue.then(async()=>{
  const delay=Math.max(0,1100-(Date.now()-lastRequestAt));
  if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
  lastRequestAt=Date.now();
  return fetch(url,{headers:{"User-Agent":"FemmaDexDrive/2.0 contact:femmadexmanagement@gmail.com"}});
 });
 requestQueue=request.then(()=>undefined,()=>undefined);
 return request;
}

export async function reverseGeocode(lat,lng){
 if(lat===null||lat===undefined||lat===""||lng===null||lng===undefined||lng===""||!Number.isFinite(Number(lat))||Number(lat)<-90||Number(lat)>90||!Number.isFinite(Number(lng))||Number(lng)<-180||Number(lng)>180)throw new Error("A valid map location is required.");
 lat=Number(lat);
 lng=Number(lng);

 if(mapboxToken){
  const endpoint=new URL(`https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json`);
  endpoint.searchParams.set("language","en");
  endpoint.searchParams.set("limit","1");
  endpoint.searchParams.set("types","address,poi,place,locality,neighborhood,district");
  endpoint.searchParams.set("access_token",mapboxToken);
  const response=await fetch(endpoint);
  if(!response.ok)throw new Error("Mapbox address verification is temporarily unavailable.");
  const data=await response.json(),feature=data.features?.find(item=>typeof item.place_name==="string"&&item.place_name.trim());
  if(!feature)throw new Error("No readable street or place name was found for this point. Move the pin to a nearby road or landmark.");
  return {title:feature.text||feature.place_name.trim(),details:"",address:feature.place_name.trim(),lat,lng};
 }

 const response=await fetchGeocoding(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`);
 if(!response.ok)throw new Error("Address lookup is temporarily unavailable.");
 const item=await response.json(),parts=item.address||{},street=[parts.house_number,parts.road].filter(Boolean).join(" "),title=item.name||parts.amenity||parts.shop||parts.tourism||parts.leisure||parts.building||street||parts.neighbourhood||parts.suburb||parts.village||parts.town||parts.city||parts.county;
 const locality=[street,parts.neighbourhood,parts.suburb,parts.village,parts.town,parts.city,parts.state,parts.country].filter((part,index,all)=>part&&all.indexOf(part)===index&&part!==title);
 const address=[title,...locality].filter(Boolean).join(", ");
 if(!address)throw new Error("No readable street or place name was found for this point. Move the pin to a nearby road or landmark.");
 return {title:title||"Selected location",details:locality.join(", "),address,lat,lng};
}
