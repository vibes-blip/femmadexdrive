export default async req=>{
 if(req.method==="OPTIONS")return new Response("",{status:204});
 const u=new URL(req.url),lat=Number(u.searchParams.get("lat")),lng=Number(u.searchParams.get("lng"));
 if(!Number.isFinite(lat)||!Number.isFinite(lng))return new Response(JSON.stringify({error:"Invalid coordinates"}),{status:400,headers:{"Content-Type":"application/json"}});
 const r=await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,{headers:{"User-Agent":"FemmaDexDrive/2.0 contact:femmadexmanagement@gmail.com"}});
 if(!r.ok)return new Response(JSON.stringify({error:"Reverse geocoding failed"}),{status:502,headers:{"Content-Type":"application/json"}});
 const d=await r.json();return new Response(JSON.stringify({address:d.display_name||`${lat}, ${lng}`}),{headers:{"Content-Type":"application/json"}});
};
