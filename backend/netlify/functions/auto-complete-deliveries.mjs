import {sb,json,err} from './_lib.mjs';

export const config={schedule:'*/1 * * * *'};

export default async req=>{
  try{
    const db=sb();
    const {data,error}=await db.rpc('auto_complete_deliveries');
    if(error) throw error;
    return json({ok:true,completed:Number(data||0)});
  }catch(e){return err(e)}
};
