import {json} from "./_lib.mjs";

export default async req=>{
 if(req.method==="OPTIONS")return new Response("",{status:204});
 return json({error:"Direct order creation is no longer supported. Submit a delivery quote through /api/quote."},410);
};
