import {reverseGeocode} from "./_geocoding.mjs";

const headers={"Content-Type":"application/json","Access-Control-Allow-Origin":process.env.APP_ORIGIN||"*","Access-Control-Allow-Methods":"GET, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Authorization"};
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
export default async req=>{
 if(req.method==="OPTIONS")return new Response("",{status:204,headers});
 const u=new URL(req.url),lat=Number(u.searchParams.get("lat")),lng=Number(u.searchParams.get("lng"));
 if(!Number.isFinite(lat)||lat < -90||lat>90||!Number.isFinite(lng)||lng < -180||lng>180)return reply({error:"Invalid coordinates"},400);
 try{
  return reply(await reverseGeocode(lat,lng));
 }catch(error){
  const status=error.message.startsWith("No readable")?404:error.message.startsWith("A valid")?400:502;
  if(status===502)console.error("Reverse address lookup failed",error);
  return reply({error:error.message},status);
 }
};
