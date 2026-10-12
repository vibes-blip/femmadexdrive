import test from "node:test";
import assert from "node:assert/strict";
import {processSupportEscalations} from "../netlify/functions/_support-escalation.mjs";

function mockDatabase({requests=[{id:"conversation-1",customer_id:"customer-1"}],claim=true,failNotification=false}={}){
 const updates=[];
 const filters=[];
 const db={
  from(table){
   assert.equal(table,"support_conversations");
   const builder={operation:null,filters};
   for(const method of ["select","in","not","is","lte","or","limit","eq"]){
    builder[method]=(...args)=>{filters.push([method,...args]);return builder};
   }
   builder.update=values=>{builder.operation=values;updates.push(values);return builder};
   builder.maybeSingle=async()=>({data:claim?{id:"conversation-1"}:null,error:null});
   builder.then=(resolve,reject)=>{
    const result=builder.operation
     ?{data:null,error:null}
     :{data:requests,error:null};
    return Promise.resolve(result).then(resolve,reject);
   };
   return builder;
  }
 };
 return {db,updates,filters,failNotification};
}

test("overdue support requests are claimed, notified and flagged for attention",async()=>{
 const fake=mockDatabase();
 const notifications=[];
 const notified=await processSupportEscalations({
  db:fake.db,
  now:120_000,
  notify:async(...args)=>notifications.push(args)
 });
 assert.equal(notified,1);
 assert.equal(notifications.length,1);
 assert.match(notifications[0][0],/awaiting attention/);
 assert.ok(fake.filters.some(([method,...args])=>method==="lte"&&args[0]==="human_requested_at"&&args[1]===new Date(60_000).toISOString()));
 assert.deepEqual(fake.updates[0],{escalation_claimed_at:new Date(120_000).toISOString(),attention_notified_at:new Date(120_000).toISOString(),needs_attention:true});
 assert.deepEqual(fake.updates[1],{escalation_claimed_at:null});
});

test("a request another worker already claimed is not notified twice",async()=>{
 const fake=mockDatabase({claim:false});
 let count=0;
 const notified=await processSupportEscalations({db:fake.db,now:120_000,notify:async()=>count++});
 assert.equal(notified,0);
 assert.equal(count,0);
});

test("failed notification retains a short claim to back off duplicate retries",async()=>{
 const fake=mockDatabase();
 const failure=new Error("mail provider unavailable");
 const previous=console.error;
 console.error=()=>{};
 try{
  const notified=await processSupportEscalations({
   db:fake.db,
   now:120_000,
   notify:async()=>{throw failure}
  });
  assert.equal(notified,0);
 }finally{console.error=previous}
 assert.deepEqual(fake.updates[0],{escalation_claimed_at:new Date(120_000).toISOString(),attention_notified_at:new Date(120_000).toISOString(),needs_attention:true});
 assert.deepEqual(fake.updates[1],{attention_notified_at:null,needs_attention:true});
});
