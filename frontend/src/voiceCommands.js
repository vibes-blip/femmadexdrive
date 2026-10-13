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
 return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/'/g,"").replace(/&/g," and ").replace(/[^\p{L}\p{N}@.+\s-]/gu," ").replace(/\s+/g," ").trim();
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

export function voiceCommand(transcript,language="en"){
 const normalized=normalize(transcript);
 const words=normalized.split(" ").filter(Boolean);
 if(!words.length)return{type:"unknown",message:helpReply};

 if(/^(?:please\s+)?(?:(?:stop|close|cancel)(?:\s+and\s+(?:close|stop))?|(?:close|stop)\s+and\s+(?:close|stop))(?:\s+(?:the|my))?(?:\s+(?:voice(?:\s+control)?|microphone|mic|listening|assistant|speech|speaking))?$/.test(normalized)){
  return{type:"stop",message:"Voice control stopped and closed."};
 }

 const localized=localizedVoiceCommand(normalized,language);
 if(localized)return localized;

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

function localizedVoiceCommand(normalized,language){
 const locale=String(language||"").split("-")[0].toLowerCase();
 const requests={
  fr:[
   [/^(?:bonjour|salut|bonsoir)$/, "greeting"],
   [/^(?:je veux|je voudrais|pouvez-vous m aider).*?(?:livraison|colis|envoyer)/,"book"],
   [/^(?:suivre|localiser|ou est|ou se trouve).*?(?:colis|livraison|paquet)/,"track"],
   [/^(?:aide|assistance|parler au support|contacter le support)$/,"support"]
  ],
  es:[
   [/^(?:hola|buenos dias|buenas tardes)$/, "greeting"],
   [/^(?:quiero|quisiera|puedes ayudarme).*?(?:envio|entrega|paquete)/,"book"],
   [/^(?:rastrear|seguir|donde esta).*?(?:paquete|envio|pedido)/,"track"],
   [/^(?:ayuda|soporte|hablar con soporte)$/,"support"]
  ],
  pt:[
   [/^(?:ola|bom dia|boa tarde)$/, "greeting"],
   [/^(?:quero|gostaria|pode me ajudar).*?(?:entrega|encomenda|enviar)/,"book"],
   [/^(?:rastrear|acompanhar|onde esta).*?(?:encomenda|entrega|pacote|pedido)/,"track"],
   [/^(?:ajuda|suporte|falar com suporte)$/,"support"]
  ],
  yo:[
   [/^(?:bawo ni|e kaaro|eku abo)$/, "greeting"],
   [/^(?:mo fe|e jowo).*?(?:ranse|firanse|eru|package)/,"book"],
   [/^(?:ibo ni|nibo ni).*?(?:package|eru|delivery)/,"track"],
   [/^(?:iranlowo|mo fe ba support soro)$/,"support"]
  ],
  ha:[
   [/^(?:sannu|ina kwana|barka da safiya)$/, "greeting"],
   [/^(?:ina so|don Allah).*?(?:aika|kaya|kofa)/,"book"],
   [/^(?:ina|ina ne).*?(?:kaya|kunshi|delivery)/,"track"],
   [/^(?:taimako|support|ina so in yi magana da support)$/,"support"]
  ],
  ig:[
   [/^(?:ndewo|kedu|ututu oma)$/, "greeting"],
   [/^(?:achoro m|choro m|biko).*?(?:iziga|ngwugwu)/,"book"],
   [/^(?:ebe ka|kedu ebe).*?(?:ngwugwu|ngwugwu m)/,"track"],
   [/^(?:enyemaka|support|choro m enyemaka)$/,"support"]
  ],
  sw:[
   [/^(?:habari|jambo|hujambo)$/, "greeting"],
   [/^(?:nataka|tafadhali).*?(?:kutuma|kifurushi|kupeleka)/,"book"],
   [/^(?:fuatilia|kifurushi kiko wapi|iko wapi).*?(?:kifurushi|mzigo)/,"track"],
   [/^(?:msaada|zungumza na huduma)$/,"support"]
  ],
  ar:[
   [/^(?:مرحبا|اهلا|السلام عليكم)$/, "greeting"],
   [/^(?:اريد|أريد|من فضلك).*?(?:توصيل|طرد|ارسال|إرسال)/,"book"],
   [/^(?:اين|أين|تتبع).*?(?:طرد|توصيل|طلب)/,"track"],
   [/^(?:مساعدة|الدعم|خدمة العملاء)$/,"support"]
  ]
 };
 const match=(requests[locale]||[]).find(([pattern])=>pattern.test(normalized));
 if(!match)return null;
 const [,intent]=match;
 if(intent==="greeting")return{type:"reply",message:welcomeMessageFor(locale)};
 if(intent==="book")return{type:"navigate",path:"/book",message:"I’ll open the delivery booking form. You can review and confirm the booking yourself."};
 if(intent==="track")return{type:"navigate",path:"/track",message:"I’ll open delivery tracking so you can check your package."};
 return{type:"support",message:"I’ll open FemmaDexCare so you can get help."};
}

function welcomeMessageFor(locale){
 const greetings={
  fr:"Bonjour ! Je suis l’assistant vocal FemmaDex. Je peux vous aider à réserver ou suivre une livraison, choisir une option de livraison, trouver des informations sur les livreurs ou contacter FemmaDexCare. Comment puis-je vous aider ?",
  es:"¡Hola! Soy el asistente de voz de FemmaDex. Puedo ayudarte a reservar o rastrear una entrega, elegir una opción, encontrar información para repartidores o contactar con FemmaDexCare. ¿Cómo puedo ayudarte?",
  pt:"Olá! Sou o assistente de voz da FemmaDex. Posso ajudar a agendar ou acompanhar uma entrega, escolher uma opção, encontrar informações para entregadores ou contactar a FemmaDexCare. Como posso ajudar?",
  yo:"E kaabo! Emi ni oluranlọwọ ohun FemmaDex. Mo le ran ọ lọwọ lati fi ẹru ranṣẹ, tọpinpin ẹru, yan iru ifijiṣẹ, tabi kan si FemmaDexCare. Bawo ni mo ṣe le ran ọ lọwọ?",
  ha:"Sannu! Ni ne mataimakin muryar FemmaDex. Zan iya taimaka maka wajen aika kaya, bibiyar kaya, zabar hanyar kai kaya, ko tuntubar FemmaDexCare. Ta yaya zan taimaka?",
  ig:"Ndewo! Abum onye enyemaka olu FemmaDex. Enwere m ike inyere gị aka iziga ngwugwu, soro ngwugwu, họrọ ụdị nnyefe, ma ọ bụ kpọtụrụ FemmaDexCare. Kedu ka m ga-esi nyere gị aka?",
  sw:"Habari! Mimi ni msaidizi wa sauti wa FemmaDex. Naweza kukusaidia kutuma au kufuatilia kifurushi, kuchagua huduma ya uwasilishaji, au kuwasiliana na FemmaDexCare. Nikusaidie vipi?",
  ar:"مرحباً! أنا المساعد الصوتي من FemmaDex. يمكنني مساعدتك في حجز التوصيل أو تتبعه أو اختيار خدمة التوصيل أو التواصل مع FemmaDexCare. كيف يمكنني مساعدتك؟"
 };
 return greetings[locale]||"Hi! I’m FemmaDex voice assistant. I can help you book or track a delivery, choose a delivery option, find rider information, or contact FemmaDexCare. What can I help you with?";
}

export function wakeRequest(transcript){
 const normalized=normalize(transcript);
 const match=normalized.match(/(?:^|\s)(?:hey\s+)?femma\s*dex(?:\s+(?:hi|hello|hey|good\s+morning|good\s+afternoon|good\s+evening|bonjour|salut|bonsoir|hola|buenos\s+dias|buenas\s+tardes|buenas\s+noches|ola|bom\s+dia|boa\s+tarde|boa\s+noite|habari|jambo|sannu|barka\s+da\s+safiya|barka\s+da\s+yamma|ndewo|kedu|hujambo|bawo\s+ni|e\s+kaaro|eku\s+abo|ina\s+kwana|مرحبا|السلام\s+عليكم))?(?:\s+(.*))?$/u);
 if(!match)return null;
 return{text:(match[1]||"").trim()};
}

export function greetingPhrase(language){
 const greetings={fr:"bonjour",es:"hola",yo:"bawo ni",ha:"sannu",ig:"ndewo",sw:"habari",ar:"مرحبا"};
 return greetings[String(language||"").split("-")[0].toLowerCase()]||"hi";
}

export {helpReply,servicesReply};
