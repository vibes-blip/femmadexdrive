import {verifyReference,markPayment} from "./create-paystack-payment.mjs";

export default async req=>{
  const u=new URL(req.url), ref=u.searchParams.get("reference")||u.searchParams.get("trxref");
  const frontendOrigin=process.env.APP_ORIGIN||u.origin;
  if(!ref) return Response.redirect(`${frontendOrigin}/payment-result?status=missing`,303);
  try{
    const data=await verifyReference(ref);
    const ok=await markPayment(data);
    return Response.redirect(`${frontendOrigin}/payment-result?status=${ok?"success":"failed"}&reference=${encodeURIComponent(ref)}`,303);
  }catch{
    return Response.redirect(`${frontendOrigin}/payment-result?status=pending&reference=${encodeURIComponent(ref)}`,303);
  }
};
