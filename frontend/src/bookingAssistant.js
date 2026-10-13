const bounded=(value,max=500)=>String(value||"").trim().replace(/\s+/g," ").slice(0,max);

export function bookingDetailsFromConversation(conversation){
 const entries=Array.isArray(conversation)?conversation:[];
 const source=bounded(entries.length?entries.filter(item=>item?.sender_type==="customer").map(item=>item.body).join("\n"):conversation,5000);
 const details={};
 for(let index=0;index<entries.length;index++){
  const item=entries[index];
  if(item?.sender_type!=="customer"||!bounded(item.body))continue;
  const previous=entries.slice(0,index).reverse().find(message=>message?.sender_type==="ai")?.body||"";
  if(!details.pickup&&/\b(?:pickup|pick-up|collection|collect|sender address)\b/i.test(previous))details.pickup=bounded(item.body,500);
  else if(!details.dropoff&&/\b(?:destination|drop[- ]?off|deliver(?:y)? address)\b/i.test(previous))details.dropoff=bounded(item.body,500);
  else if(!details.recipientName&&/\b(?:recipient|receiver).{0,20}\bname\b/i.test(previous)){
   const response=bounded(item.body).match(/^([\p{L}][\p{L}\p{M}' -]{1,118}?)(?=\s+(?:and\s+)?(?:the\s+)?(?:number|phone|package|parcel)\b|[,;.!?]|$)/iu)?.[1];
   details.recipientName=bounded(response||item.body,120);
  }
  else if(!details.recipientPhone&&/\b(?:recipient|receiver).{0,30}\bphone\b/i.test(previous))details.recipientPhone=bounded(item.body,40);
  else if(!details.description&&/\b(?:package|parcel|item|goods|what).{0,30}\b(?:send|delivering|deliver|package|item)\b/i.test(previous))details.description=bounded(item.body,2000);
 }
 const route=source.match(/\bfrom\s+(.+?)\s+to\s+(.+?)(?=\s+(?:with|for\s+(?:the\s+)?(?:recipient|receiver)|recipient|receiver|package|parcel|item|goods)\b|[,;.!?]|$)/i);
 if(route){
  details.pickup=details.pickup||bounded(route[1],500);
  details.dropoff=details.dropoff||bounded(route[2],500);
 }
 const pickup=source.match(/\b(?:pickup|pick-up|collection)(?:\s+(?:address|location|point))?\s*(?:is|at|from|:)?\s+(.+?)(?=\s+(?:destination|drop[- ]?off|recipient|receiver|package|parcel|item|phone)\b|[,;.!?]|$)/i);
 if(pickup&&!details.pickup)details.pickup=bounded(pickup[1],500);
 const destination=source.match(/\b(?:destination|drop[- ]?off)(?:\s+(?:address|location|point))?\s*(?:is|at|to|:)?\s+(.+?)(?=\s+(?:pickup|pick-up|recipient|receiver|package|parcel|item|phone)\b|[,;.!?]|$)/i);
 if(destination&&!details.dropoff)details.dropoff=bounded(destination[1],500);
 const recipient=source.match(/\b(?:recipient|receiver)(?:\s+name)?\s*(?:is|:)?\s+([\p{L}][\p{L}\p{M}' -]{1,118}?)(?=\s+(?:and\s+)?(?:the\s+)?(?:number|phone|package|parcel|from|to|pickup|destination)\b|[,;.!?]|$)/iu);
 if(recipient)details.recipientName=details.recipientName||bounded(recipient[1],120);
 const phone=source.match(/(?:\+?\d[\d\s().-]{7,18}\d)/);
 if(phone)details.recipientPhone=details.recipientPhone||bounded(phone[0],40);
 const category=source.match(/\b(bulky|large|fast|urgent|small|medium)\b/i)?.[1]?.toLowerCase();
 if(category){
  if(["bulky","large"].includes(category))details.packageCategory="bulky";
  else if(category==="small"||category==="medium")details.packageCategory=category;
  if(category==="fast"||category==="urgent")details.deliverySpeed="fast";
 }
 const item=source.match(/\b(?:package|parcel|item|goods)\s+(?:is|are|contains?|:)?\s*(.+?)(?=\s+(?:from|pickup|pick-up|destination|drop[- ]?off|recipient|receiver|phone)\b|[,;.!?]|$)/i);
 if(item)details.description=details.description||bounded(item[1],2000);
 return details;
}
