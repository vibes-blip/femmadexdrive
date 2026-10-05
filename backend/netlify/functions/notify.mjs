import {sb,json,body,err,userFromRequest} from "./_lib.mjs";

const escapeHtml=value=>String(value||"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));

const sendEmail=async(to,subject,html)=>{
 if(!process.env.RESEND_API_KEY)throw new Error("Rider approval email is not configured (RESEND_API_KEY is missing).");
 const response=await fetch("https://api.resend.com/emails",{
  method:"POST",
  headers:{"Authorization":`Bearer ${process.env.RESEND_API_KEY}`,"Content-Type":"application/json"},
  body:JSON.stringify({
   from:process.env.RESEND_FROM_EMAIL||"onboarding@resend.dev",
   to:[to],
   subject,
   html
  })
 });
 if(!response.ok)throw new Error("Rider approval email could not be sent.");
};

export const sendAdmin=async(subject,html)=>{
 if(!process.env.RESEND_API_KEY)return;
 const response=await fetch("https://api.resend.com/emails",{
  method:"POST",
  headers:{"Authorization":`Bearer ${process.env.RESEND_API_KEY}`,"Content-Type":"application/json"},
  body:JSON.stringify({
   from:process.env.RESEND_FROM_EMAIL||"onboarding@resend.dev",
   to:[process.env.ADMIN_EMAIL||"femmadexmanagement@gmail.com"],
   subject,
   html
  })
 });
 if(!response.ok)throw new Error("Email notification failed");
};

export default async req=>{
 if(req.method==="OPTIONS")return new Response("",{status:204});
 try{
  const user=await userFromRequest(req),request=await body(req),db=sb();
  if(request.type==="new_delivery"){
   const {data:order,error}=await db.from("orders").select("*").eq("id",request.orderId).eq("customer_id",user.id).single();
   if(error||!order)throw new Error("Delivery not found");
   await sendAdmin(`New FEMADEXDRIVE delivery ${order.tracking_number}`,`<h2>New delivery</h2><p><b>Tracking:</b> ${order.tracking_number}</p><p><b>Customer:</b> ${user.user_metadata?.full_name||"Customer"}</p><p><b>Pickup:</b> ${order.pickup_address}</p><p><b>Destination:</b> ${order.dropoff_address}</p><p><b>Package:</b> ${order.goods_description}</p><p><b>Weight:</b> ${order.weight_kg||"—"} kg</p><p><b>Vehicle:</b> ${order.vehicle_type}</p><p><b>Distance:</b> ${order.distance_km} km</p><p><b>Price:</b> ₦${Number(order.final_price).toLocaleString()}</p>`);
  }else if(request.type==="new_customer"||request.type==="new_rider"){
   const role=request.type==="new_rider"?"Rider application":"Customer signup";
   await sendAdmin(`FEMADEXDRIVE ${role}`,`<h2>${role}</h2><p><b>Name:</b> ${user.user_metadata?.full_name||"—"}</p><p><b>Email:</b> ${user.email||"—"}</p><p><b>Phone:</b> ${user.user_metadata?.phone||"—"}</p><p><b>Role:</b> ${request.type==="new_rider"?"rider":"customer"}</p><p><b>Time:</b> ${new Date().toISOString()}</p>`);
  }else if(request.type==="rider_approved"){
   const {data:adminProfile,error:adminError}=await db.from("profiles").select("role").eq("id",user.id).single();
   if(adminError||!["admin","supervisor"].includes(adminProfile?.role))throw new Error("Operations access required");
   const {data:rider,error:riderError}=await db.from("riders").select("approval_status,display_name,phone").eq("id",request.riderId).single();
   if(riderError||!rider)throw new Error("Rider application not found");
   if(rider.approval_status!=="approved")throw new Error("Rider approval must be saved before sending confirmation");
   const {data:profile,error:profileError}=await db.from("profiles").select("full_name,email").eq("id",request.riderId).single();
   if(profileError||!profile?.email)throw new Error("The approved rider has no email address");
   const name=escapeHtml(profile.full_name||rider.display_name||"Rider");
   const portalUrl=`${(process.env.APP_ORIGIN||"https://femmadexdrive.netlify.app").replace(/\/+$/,"")}/rider`;
   await sendEmail(profile.email,"Your FemmaDexDrive rider application is approved",`<h2>Welcome to FemmaDexDrive, ${name}</h2><p>Your rider application has been approved. Sign in to the rider portal to go online and view eligible deliveries.</p><p><a href="${escapeHtml(portalUrl)}">Open rider portal</a></p><p>If you did not apply to become a rider, contact FemmaDexDrive support.</p>`);
  }else{
   throw new Error("Unsupported notification type");
  }
  return json({ok:true});
 }catch(error){
  return err(error);
 }
};
