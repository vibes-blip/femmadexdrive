const fieldAliases=[
 {field:"pickup",labels:[["pickup","address"],["pick","up","address"],["pickup"],["pick","up"],["collection"],["origin"]]},
 {field:"dropoff",labels:[["destination","address"],["drop","off","address"],["destination"],["drop","off"],["dropoff"],["receiver","address"],["deliver","to"]]},
 {field:"description",labels:[["package","description"],["package","details"],["parcel","details"],["item","description"],["describe","package"],["items","inside"],["package","contains"]]},
 {field:"recipientName",labels:[["recipient","name"],["receiver","name"],["recipient"],["receiver"]]},
 {field:"recipientPhone",labels:[["recipient","phone"],["phone","number"],["mobile","number"],["phone"],["mobile"]]},
 {field:"customerEmail",labels:[["contact","email"],["email","address"],["email"]]}
];

const helpReply="I can help you book a delivery, track a package, choose a delivery category, find rider information, open dispatch terms, or contact FemmaDexCare. You can say, for example, “book a delivery”, “track my parcel”, “pickup from Ikeja”, or “what services do you offer”.";
const servicesReply="FemmaDex offers small and medium parcel delivery, large or bulky item delivery, and a fast delivery option with a two-hour target after a rider accepts the delivery. You can also track packages, get rider information, and contact FemmaDexCare. Say “book a delivery” to get started.";

function normalize(text){
 return text.toLowerCase().replace(/'/g,"").replace(/&/g," and ").replace(/[^\p{L}\p{N}@.+\s-]/gu," ").replace(/\s+/g," ").trim();
}

function editDistance(left,right){
 if(Math.abs(left.length-right.length)>1)return 2;
 let previous=Array.from({length:right.length+1},(_,index)=>index);
 for(let row=1;row<=left.length;row++){
  const current=[row];
  for(let column=1;column<=right.length;column++){
   current[column]=Math.min(current[column-1]+1,previous[column]+1,previous[column-1]+(left[row-1]===right[column-1]?0:1));
  }
  previous=current;
 }
 return previous[right.length];
}

function wordMatches(spoken,expected){
 return spoken===expected||(spoken.length>=4&&expected.length>=4&&editDistance(spoken,expected)<=1);
}

function labelMatches(words,label){
 if(words.length<label.length)return false;
 return label.every((part,index)=>wordMatches(words[index],part));
}

function matchingLabel(words,labels){
 return [...labels].sort((left,right)=>right.length-left.length).find(label=>labelMatches(words,label));
}

function voiceFill(transcript,words){
 const originalWords=transcript.match(/[\p{L}\p{N}@.+-]+(?:'[\p{L}\p{N}]+)*/gu)||[];
 const start=Math.max(0,words.findIndex(word=>!["please","can","could","you","i","would","like","to","set","add","enter","update","my","the","a","for","me"].includes(word)));
 const searchable=words.slice(start);
 for(const item of fieldAliases){
  const label=matchingLabel(searchable,item.labels);
  if(!label)continue;
  const value=originalWords.slice(start+label.length).join(" ").replace(/^(?:is|at|from|to|equals|as)\s+/i,"").replace(/^[-:,]\s*/,"").trim()||searchable.slice(label.length).join(" ");
  if(value){
   const limit=item.field==="description"?2000:item.field==="recipientName"?120:500;
   return{type:"fill",field:item.field,value:value.slice(0,limit)};
  }
 }

 const categoryAliases=[
  {value:"fast",words:["fast","express","urgent"]},
  {value:"standard",words:["standard","regular","normal"]},
  {value:"small",words:["small"]},
  {value:"medium",words:["medium"]},
  {value:"bulky",words:["bulky","large","heavy"]}
 ];
 const categoryIndex=searchable.findIndex(word=>categoryAliases.some(item=>item.words.some(alias=>wordMatches(word,alias))));
 if(categoryIndex>=0&&(searchable.length<=3||searchable.some(word=>["delivery","category","service","parcel","package","choose","select","want","need","make"].some(alias=>wordMatches(word,alias))))){
  const word=searchable[categoryIndex];
  const category=categoryAliases.find(item=>item.words.some(alias=>wordMatches(word,alias)));
  return{type:"fill",field:"deliveryCategory",value:category.value};
 }
 return null;
}

export function voiceCommand(transcript){
 const normalized=normalize(transcript);
 const words=normalized.split(" ").filter(Boolean);
 if(!words.length)return{type:"unknown",message:helpReply};

 if(/^(?:please\s+)?(?:(?:stop|close|cancel)(?:\s+and\s+(?:close|stop))?|(?:close|stop)\s+and\s+(?:close|stop))(?:\s+(?:the|my))?(?:\s+(?:voice(?:\s+control)?|microphone|mic|listening|assistant|speech|speaking))?$/.test(normalized)){
  return{type:"stop",message:"Voice control stopped and closed."};
 }

 const fill=voiceFill(transcript,words);
 if(fill)return fill;

 const has=(...terms)=>words.some(word=>terms.some(term=>wordMatches(word,term)));
 const asksAboutServices=has("offer","offers","service","services","provide","available")||
  (has("what","which","how")&&has("do","can","does")&&has("you"))||
  (has("can","could")&&has("you")&&has("help","assist"));
 if(asksAboutServices)return{type:"reply",message:servicesReply};

 if(has("price","cost","quote","fare","charge","charges","expensive")){
  return{type:"reply",message:"I can help you get a delivery quote. The quote depends on your pickup and destination, parcel category, and delivery option. Say “book a delivery” and choose the map suggestions to confirm the locations."};
 }

 if((has("track","tracking","where","status","find","locate")&&(has("package","parcel","delivery","order","it","my")||words.length<4))||
   (has("package","parcel","delivery")&&has("where","status"))){
  return{type:"navigate",path:"/track",message:"I’ll open delivery tracking. Enter your tracking details there to check your package."};
 }
 if(has("support","care","agent","assistant","femmadexcare","ai")&&(has("talk","speak","open","contact","help","need","want","customer")||words.length<=3)){
  return{type:"support",message:"I’ll open FemmaDexCare so you can get help."};
 }
 if(has("rider","riders","riding","driver")&&(has("become","join","work","information","info","want","how","as")||words.length<=3)){
  return{type:"navigate",path:"/rider",message:"I’ll open information about becoming a FemmaDex rider."};
 }
 if(has("term","terms","condition","conditions","policy","policies")){
  return{type:"navigate",path:"/terms",message:"I’ll open the dispatch terms for you."};
 }
 if(has("home","homepage")){
  return{type:"navigate",path:"/",message:"I’ll take you to the FemmaDex home page."};
 }
 if(has("book","booking","send","deliver","delivery","parcel","package","courier")&&(has("book","booking","send","deliver","delivery","parcel","package","courier","want","need","make","create","arrange")||words.length<=3)){
  return{type:"navigate",path:"/book",message:"I’ll open the delivery booking form. I can help fill in the details, and you’ll review and confirm the booking yourself."};
 }
 if(has("hello","hi","hey","thanks","thank")){
  if(has("femmadex")&&has("hello","hi","hey")){
   return{type:"reply",message:"Hi! I’m FemmaDex voice assistant. I can help you book or track a delivery, choose a delivery option, find rider information, or contact FemmaDexCare. What can I help you with?"};
  }
  if(has("hello","hi","hey")){
   return{type:"reply",message:"Hi! I’m FemmaDex voice assistant. I can help you book or track a delivery, choose a delivery option, find rider information, or contact FemmaDexCare. What can I help you with?"};
  }
  return{type:"reply",message:"You’re welcome. I can help with delivery bookings, package tracking, rider information, or FemmaDexCare support. What would you like to do?"};
 }
 return{type:"unknown",message:`I’m not sure I understood that request. ${helpReply}`};
}

export {helpReply,servicesReply};
