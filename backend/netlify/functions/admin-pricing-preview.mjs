import {sb,json,body,err,HttpError,userFromRequest} from "./_lib.mjs";
import {calculateInterstatePrice} from "./_interstate-pricing.mjs";

export default async request=>{
 if(request.method==="OPTIONS")return new Response("",{status:204});
 try{
  const user=await userFromRequest(request);
  const db=sb();
  const {data:profile,error:profileError}=await db.from("profiles").select("role").eq("id",user.id).maybeSingle();
  if(profileError)throw new HttpError("Your Operations role could not be verified.",503);
  if(!["admin","supervisor"].includes(profile?.role))throw new HttpError("Operations access required.",403);
  const input=await body(request);
  if(!input||typeof input!=="object"||Array.isArray(input))throw new HttpError("Pricing preview details are invalid.",400);
  const distanceMeters=Number(input?.distanceMeters);
  if(!Number.isFinite(distanceMeters)||distanceMeters<=0)throw new HttpError("Enter a positive test route distance.",400);
  let result;
  try{result=calculateInterstatePrice(distanceMeters,input.pricing,input.serviceTier)}
  catch(error){throw new HttpError(error.message,422)}
  return json(result);
 }catch(error){return err(error)}
};
