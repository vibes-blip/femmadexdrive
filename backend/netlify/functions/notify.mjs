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
 if(!process.env.RESEND_API_KEY)throw new Error("Operations email is not configured (RESEND_API_KEY is missing).");
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
   const {data:quote,error:quoteError}=await db.from("delivery_quote_reviews")
    .select("suggested_price,requires_manual_review")
    .eq("order_id",order.id)
    .maybeSingle();
   if(quoteError)throw quoteError;
   const dimensions=[order.length_cm,order.width_cm,order.height_cm].some(value=>value!==null&&value!==undefined)
    ?`${order.length_cm||"—"} × ${order.width_cm||"—"} × ${order.height_cm||"—"} cm`
    :"—";
   const point=(lat,lng)=>lat!==null&&lat!==undefined&&lat!==""&&lng!==null&&lng!==undefined&&lng!==""&&Number.isFinite(Number(lat))&&Number.isFinite(Number(lng))?`${Number(lat)}, ${Number(lng)}`:"—";
   const field=(label,value)=>`<p><b>${label}:</b> ${escapeHtml(value||"—")}</p>`;
   await sendAdmin(
    `New FEMADEXDRIVE delivery ${order.tracking_number}`,
    `<h2>New delivery</h2>
     ${field("Tracking",order.tracking_number)}
     ${field("Customer",user.user_metadata?.full_name||"Customer")}
     ${field("Customer email",user.email)}
     ${field("Customer phone",user.user_metadata?.phone)}
     ${field("Pickup",order.pickup_address)}
     ${field("Pickup coordinates",point(order.pickup_latitude,order.pickup_longitude))}
     ${field("Destination",order.dropoff_address)}
     ${field("Destination coordinates",point(order.dropoff_latitude,order.dropoff_longitude))}
     ${field("Recipient",order.recipient_name)}
     ${field("Recipient phone",order.recipient_phone)}
     ${field("Package",order.goods_description)}
     ${field("Package size",order.package_size)}
     ${field("Weight",order.weight_kg?`${order.weight_kg} kg`:"—")}
     ${field("Dimensions",dimensions)}
     ${field("Vehicle",order.vehicle_type)}
     ${field("Road distance",order.distance_km?`${order.distance_km} km`:"—")}
     ${field("Estimated drive time",order.duration_minutes?`${order.duration_minutes} minutes`:"—")}
     ${field("System suggested price",quote?`₦${Number(quote.suggested_price).toLocaleString()}`:"Awaiting operations review")}
     ${field("Manual review required",quote?.requires_manual_review?"Yes":"No")}
     ${field("Status",order.status)}
     <p>Review and manage this delivery in the operations dashboard.</p>`
   );
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
