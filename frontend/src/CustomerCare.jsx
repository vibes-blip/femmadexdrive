import React,{useEffect,useRef,useState} from "react";
import {ArrowRight,Clock3,Headphones,MessageCircle,Mic,Send,Volume2,VolumeX,X} from "lucide-react";
import {API_BASE} from "./api.js";

const clean=value=>String(value||"").replace(/[<>]/g,"").trim();
const time=value=>value?new Date(value).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):"";
const aiLanguage=()=>navigator.language||"en";
const CARE_CONVERSATION_KEY="fddCareConversation";

function speechRecognition(){
 if(typeof window==="undefined")return null;
 return window.SpeechRecognition||window.webkitSpeechRecognition||null;
}

export function CustomerCareChat({session,supabase,toast,open:openAuth}){
 const [open,setOpen]=useState(false),[loading,setLoading]=useState(false),[conversationId,setConversationId]=useState(null),[conversationStatus,setConversationStatus]=useState("waiting");
 const [messages,setMessages]=useState([]),[text,setText]=useState(""),[notice,setNotice]=useState(""),[error,setError]=useState("");
 const [listening,setListening]=useState(false),[speaking,setSpeaking]=useState(false),[muted,setMuted]=useState(false);
 const recognitionRef=useRef(null),audioRef=useRef(null),careMemoryRestored=useRef(false),skipCareMemorySave=useRef(false);
 const stopCurrentSpeech=()=>{
  window.speechSynthesis?.cancel();
  const active=audioRef.current;
  audioRef.current=null;
  if(active){active.audio.pause();active.audio.src="";URL.revokeObjectURL(active.url)}
  setSpeaking(false);
 };

 useEffect(()=>()=>{recognitionRef.current?.stop();stopCurrentSpeech()},[]);

 useEffect(()=>{
  const show=()=>setOpen(true);
  addEventListener("fdd-open-care",show);
  return()=>removeEventListener("fdd-open-care",show);
 },[]);

 useEffect(()=>{
  const restore=()=>{
   if(!session)return;
   try{
    const saved=JSON.parse(sessionStorage.getItem(CARE_CONVERSATION_KEY)||"null");
    if(!saved||saved.ownerId!==session.user.id||typeof saved.conversationId!=="string")return;
    setConversationId(saved.conversationId);
    setConversationStatus(saved.conversationStatus||"waiting");
    setMessages(Array.isArray(saved.messages)?saved.messages:[]);
    setText(saved.draftText||"");
    setNotice(saved.notice||"");
    setOpen(true);
    if(saved.memoryTransferError)setError(`Your previous AI chat is still visible, but could not be reconnected: ${saved.memoryTransferError}`);
    skipCareMemorySave.current=true;
   }catch(caught){setError(`Your saved FemmaDexCare history could not be restored: ${caught.message}`)}
   finally{careMemoryRestored.current=true}
  };
  const updated=()=>restore();
  restore();
  addEventListener("fdd-care-memory-updated",updated);
  return()=>removeEventListener("fdd-care-memory-updated",updated);
 },[session?.user?.id]);

 useEffect(()=>{
  if(!careMemoryRestored.current)return;
  if(skipCareMemorySave.current){skipCareMemorySave.current=false;return}
  try{
   if(!conversationId){sessionStorage.removeItem(CARE_CONVERSATION_KEY);return}
   sessionStorage.setItem(CARE_CONVERSATION_KEY,JSON.stringify({
    ownerId:session?.user?.id||null,
    conversationId,
    conversationStatus,
    messages,
    draftText:text,
    notice
   }));
  }catch(caught){setError(`Your FemmaDexCare history could not be saved on this device: ${caught.message}`)}
 },[session?.user?.id,conversationId,conversationStatus,messages,text,notice]);

 const loadMessages=async id=>{
  const {data,error:loadError}=await supabase.from("support_messages").select("id,sender_type,body,created_at")
   .eq("conversation_id",id).order("created_at",{ascending:true}).limit(100);
  if(loadError)throw new Error(`Could not load support messages: ${loadError.message}`);
  setMessages(data||[]);
  return data||[];
 };

 useEffect(()=>{
  if(!session||!conversationId)return;
  let active=true;
  loadMessages(conversationId).catch(caught=>{if(active)setError(caught.message)});
  return()=>{active=false};
 },[session?.user?.id,conversationId]);

 const start=async()=>{
  if(loading)return;
  if(!supabase){setError("Customer care is unavailable because the account service is not configured.");return}
  setLoading(true);setError("");
  try{
   let activeSession=session;
   if(!activeSession){
    const {data,error:authError}=await supabase.auth.signInAnonymously();
    if(authError)throw new Error(`Guest support is unavailable: ${authError.message}. Enable anonymous sign-ins in Supabase or sign in to continue.`);
    activeSession=data.session;
   }
   if(!activeSession)throw new Error("Could not create a private customer-care session.");
   const {data:existing,error:existingError}=await supabase.from("support_conversations")
    .select("id,support_status,human_requested_at")
    .eq("customer_id",activeSession.user.id)
    .neq("support_status","resolved")
    .order("updated_at",{ascending:false})
    .limit(1)
    .maybeSingle();
   if(existingError)throw new Error(`Could not check your open customer-care chat: ${existingError.message}`);
   let id=existing?.id;
   if(existing?.support_status){
    setConversationStatus(existing.support_status);
    if(existing.human_requested_at){
     const statusText={waiting:"Your request is waiting for a customer-care team member.",assigned:"A team member accepted your request.",responded:"Customer care has replied.",resolved:"This support request is resolved."};
     setNotice(statusText[existing.support_status]||"Your support request is being handled.");
    }
   }
   if(!id){
    const {data,error:startError}=await supabase.rpc("create_support_conversation");
    if(startError)throw new Error(`Could not start customer care: ${startError.message}`);
    if(typeof data!=="string"||!data)throw new Error("Customer care did not return a conversation ID.");
    id=data;
    setConversationStatus("waiting");
   }
   setConversationId(id);
   setNotice("");
   const loadedMessages=await loadMessages(id);
   sessionStorage.setItem(CARE_CONVERSATION_KEY,JSON.stringify({
    ownerId:activeSession.user.id,
    conversationId:id,
    conversationStatus:existing?.support_status||"waiting",
    messages:loadedMessages,
    draftText:text,
    notice:""
   }));
   dispatchEvent(new Event("fdd-care-memory-updated"));
  }catch(caught){setError(caught.message||"Could not start customer care.")}
  finally{setLoading(false)}
 };

 useEffect(()=>{
  if(!open||!conversationId)return;
  const channel=supabase.channel(`support-customer-${conversationId}`)
   .on("postgres_changes",{event:"INSERT",schema:"public",table:"support_messages",filter:`conversation_id=eq.${conversationId}`},event=>{
    setMessages(current=>current.some(message=>message.id===event.new.id)?current:[...current,event.new].sort((a,b)=>new Date(a.created_at)-new Date(b.created_at)));
   })
   .on("postgres_changes",{event:"UPDATE",schema:"public",table:"support_conversations",filter:`id=eq.${conversationId}`},event=>{
    const statuses={waiting:"Your request is waiting for a customer-care team member.",assigned:"A team member accepted your request.",responded:"Customer care has replied.",resolved:"This support request is resolved."};
    setNotice(statuses[event.new.support_status]||"Your private support chat is updated.");
    setConversationStatus(event.new.support_status);
   })
   .subscribe(status=>{if(status==="CHANNEL_ERROR")setError("Live chat updates are unavailable. Refresh or reopen this chat.");});
  return()=>{supabase.removeChannel(channel)};
 },[open,conversationId,supabase]);

 const send=async(message,requestHuman=false)=>{
  const body=clean(message);
  if(!conversationId||!body||loading)return;
  setLoading(true);setError("");setNotice("");
  try{
   const response=await fetch(`${API_BASE}/care-chat`,{
    method:"POST",
    headers:{"Content-Type":"application/json",Authorization:`Bearer ${session.access_token}`},
    body:JSON.stringify({conversationId,message:body,requestHuman,language:aiLanguage()})
   });
   const result=await response.json().catch(()=>({}));
   if(!response.ok)throw new Error(result.error||"Customer care is temporarily unavailable.");
   if(result.mode==="human"){
    setNotice(result.reply||"Your message was sent to the assigned customer-care team.");
   }else if(result.mode==="ai"){
    setNotice("AI assistant · not a human response");
   }else throw new Error("Customer care returned an unknown response.");
   await loadMessages(conversationId);
   if(result.mode==="ai"&&!muted&&result.reply)void speakReply(conversationId,result.reply);
  }catch(caught){setError(caught.message||"Your message could not be sent.");}
  finally{setLoading(false)}
 };

 const submit=event=>{event.preventDefault();const current=text;setText("");void send(current)};
 const requestHuman=()=>void send("Please connect me with a human customer-care agent.",true);
 const startVoice=()=>{
  const Recognition=speechRecognition();
  if(!Recognition){setError("Voice input is not supported by this browser. You can type your message instead.");return}
  const recognition=new Recognition();
  recognitionRef.current=recognition;
  recognition.lang=aiLanguage();
  recognition.interimResults=false;
  recognition.onresult=event=>{
   const transcript=String(event.results?.[0]?.[0]?.transcript||"").trim();
   if(!transcript)return;
   setText("");
   void send(transcript);
  };
  recognition.onerror=event=>{
   const denied=event.error==="not-allowed"||event.error==="service-not-allowed";
   setError(denied?"Microphone access was denied. Allow microphone access in your browser, or type your message instead.":"Voice input was unavailable. Check microphone permission or type your message.");
  };
  recognition.onend=()=>setListening(false);
  setError("");setListening(true);
  try{recognition.start()}catch(caught){setListening(false);setError(caught.message||"Could not start voice input.")}
 };
 const stopVoice=()=>{
  recognitionRef.current?.stop();
  recognitionRef.current=null;
  setListening(false);
 };
 const cancelVoice=()=>{
  stopVoice();
  stopCurrentSpeech();
  setText("");
 };
 const speakReply=async(conversationId,message)=>{
  try{
   const response=await fetch(`${API_BASE}/care-speech`,{
    method:"POST",
    headers:{"Content-Type":"application/json",Authorization:`Bearer ${session?.access_token||""}`},
    body:JSON.stringify({conversationId,message})
   });
   const result=await response.json().catch(()=>({}));
   if(!response.ok)throw new Error(result.error||"Gemini speech generation is unavailable.");
   if(typeof result.audioBase64!=="string"||!result.audioBase64)throw new Error("Gemini returned no speech audio.");
   stopCurrentSpeech();
   const bytes=Uint8Array.from(atob(result.audioBase64),character=>character.charCodeAt(0));
   const url=URL.createObjectURL(new Blob([bytes],{type:result.mimeType||"audio/wav"}));
   const audio=new Audio(url);
   audioRef.current={audio,url};
   audio.onended=()=>{if(audioRef.current?.audio===audio){URL.revokeObjectURL(url);audioRef.current=null;setSpeaking(false)}};
   audio.onerror=()=>{if(audioRef.current?.audio===audio){URL.revokeObjectURL(url);audioRef.current=null;setSpeaking(false);setError("The AI voice reply could not be played.")}};
   setSpeaking(true);
   await audio.play();
   return;
  }catch(error){
   stopCurrentSpeech();
   setNotice("Gemini voice is unavailable right now; using the most natural voice available in your browser.");
  }
  if(!window.speechSynthesis||!window.SpeechSynthesisUtterance){setError("Spoken replies are not supported by this browser.");return}
  window.speechSynthesis.cancel();
  const utterance=new SpeechSynthesisUtterance(message);
  utterance.lang=aiLanguage();
  utterance.rate=0.96;
  const language=aiLanguage().split("-")[0].toLowerCase();
  const voices=window.speechSynthesis.getVoices();
  utterance.voice=voices.find(voice=>voice.lang.toLowerCase().startsWith(language)&&/natural|neural|google/i.test(voice.name))||voices.find(voice=>voice.lang.toLowerCase().startsWith(language))||null;
  utterance.onend=()=>setSpeaking(false);
  utterance.onerror=()=>{setSpeaking(false);setError("The spoken reply could not be played.")};
  setSpeaking(true);window.speechSynthesis.speak(utterance);
 };
 const openBooking=()=>{
  const customerMessages=messages.filter(message=>message.sender_type==="customer");
  const request=text.trim()||customerMessages[customerMessages.length-1]?.body||"";
  if(request)sessionStorage.setItem("fddVoiceBookingRequest",request);
  history.pushState({},"","/book");
  dispatchEvent(new PopStateEvent("popstate"));
 };
 const startNewConversation=()=>{setConversationId(null);setConversationStatus("waiting");setMessages([]);setNotice("");setError("")};

 return <div className="care-widget">
  <button className="care-launcher" aria-label={open?"Close FemmaDexCare":"Open FemmaDexCare"} aria-expanded={open} title={open?"Close FemmaDexCare":"Open FemmaDexCare"} onClick={()=>setOpen(value=>!value)}>
   {open?<X size={21}/>:<MessageCircle size={21}/>}
  </button>
  {open&&<section className="care-panel" aria-label="FemmaDexCare chat">
   <div className="care-panel-head"><div><span className="eyebrow">FEMMADEXCARE</span><b>Customer support</b><small>Automated help or an available human agent</small></div><button className="care-close" onClick={()=>setOpen(false)} aria-label="Close chat"><X size={18}/></button></div>
   {!conversationId?<div className="care-start"><p>Ask FemmaDexCare about booking, delivery categories, approved pricing, tracking or delivery procedures. Voice is optional; you can always type.</p>{notice&&<p className="care-notice" role="status">{notice}</p>}{error&&<p className="care-error" role="alert">{error}</p>}<button className="primary wide" onClick={start} disabled={loading}>{loading?"Connecting…":session?"Start or resume private chat":"Start private chat as a guest"} <ArrowRight size={16}/></button><small>Guest chat is available without creating an account.</small></div>:<>
    <div className="care-messages" aria-live="polite">
     {!messages.length&&<p className="care-welcome">Hi! I’m FemmaDexCare. I can help you get started. For a confirmed delivery, continue through the secure booking dashboard.</p>}
     {messages.map(message=><article className={`care-message ${message.sender_type}`} key={message.id}><p>{message.body}</p><small>{message.sender_type==="ai"?"AI assistant":message.sender_type==="agent"?"Customer care":"You"} · {time(message.created_at)}</small>{message.sender_type==="ai"&&<button className="care-speak" onClick={()=>speakReply(conversationId,message.body)} aria-label="Speak this reply"><Volume2 size={14}/>{speaking?"Speaking":"Listen"}</button>}</article>)}
    </div>
    {notice&&<p className="care-notice" role="status">{notice}</p>}
    {error&&<p className="care-error" role="alert">{error}</p>}
    <div className="care-actions">{conversationStatus!=="resolved"&&<button className="secondary" onClick={requestHuman} disabled={loading}><Headphones size={14}/> Contact Customer Care</button>}<button className="secondary" onClick={openBooking}><ArrowRight size={14}/> Continue booking</button>{conversationStatus==="resolved"&&<button className="primary" onClick={startNewConversation}>Start a new support chat</button>}<button className="secondary" onClick={()=>{setMuted(value=>!value);stopCurrentSpeech()}} aria-label={muted?"Unmute voice replies":"Mute voice replies"}>{muted?<VolumeX size={14}/>:<Volume2 size={14}/>} {muted?"Unmute":"Mute"}</button>{listening&&<button className="secondary" onClick={stopVoice}>Stop listening</button>}{(listening||speaking)&&<button className="secondary" onClick={cancelVoice}>Cancel voice</button>}</div>
    {conversationStatus!=="resolved"&&<form className="care-form" onSubmit={submit}><button className={listening?"care-mic listening":"care-mic"} type="button" onClick={listening?stopVoice:startVoice} disabled={loading} aria-label={listening?"Stop listening":"Speak a message"}><Mic size={17}/></button><input aria-label="Message FemmaDexCare" value={text} onChange={event=>{if(listening)stopVoice();setText(event.target.value)}} maxLength={1500} placeholder={listening?"Listening… speak now":"Type or speak your request"}/><button className="primary" aria-label="Send message" disabled={loading||!text.trim()}><Send size={16}/></button></form>}
    <small className="care-disclaimer">{loading?"FemmaDexCare is processing your message…":listening?"Listening. Review your transcript before sending.":speaking?"Speaking the reply. Use Mute or Cancel to stop.":"Voice uses browser speech recognition and speech synthesis when available. AI never submits or pays for an order."} Chat messages may be processed by the configured AI provider.</small>
   </>}
  </section>}
 </div>;
}

export function CarePortal({session,profile,supabase,open,toast}){
 const [agent,setAgent]=useState(null),[conversations,setConversations]=useState([]),[selected,setSelected]=useState(null),[messages,setMessages]=useState([]),[draft,setDraft]=useState(""),[loading,setLoading]=useState(false);
 const pending=agent?.status==="pending",approved=agent?.status==="approved";
 const loadConversations=async()=>{
  if(!session||!approved)return;
  const {data,error}=await supabase.from("support_conversations").select("id,customer_id,status,support_status,needs_attention,human_requested_at,updated_at")
   .or(`assigned_agent_id.eq.${session.user.id},and(support_status.eq.waiting,human_requested_at.not.is.null)`)
   .in("support_status",["waiting","assigned","responded"]).order("updated_at",{ascending:false}).limit(50);
  if(error){toast(`Could not load care conversations: ${error.message}`);return}
  setConversations(data||[]);
  setSelected(current=>current?(data?.find(row=>row.id===current.id)||null):null);
 };
 useEffect(()=>{
  if(!session||profile?.role!=="customer_care")return;
  let active=true;
  supabase.from("customer_care_agents").select("*").eq("id",session.user.id).maybeSingle().then(({data,error})=>{
   if(!active)return;
   if(error){toast(`Could not load customer-care approval: ${error.message}`);return}
   setAgent(data);
  });
  return()=>{active=false};
 },[session?.user?.id,profile?.role,supabase,toast]);
 useEffect(()=>{
  if(!approved||!session)return;
  void loadConversations();
  const channel=supabase.channel(`care-agent-${session.user.id}`)
   .on("postgres_changes",{event:"*",schema:"public",table:"support_conversations",filter:`assigned_agent_id=eq.${session.user.id}`},loadConversations)
   .on("postgres_changes",{event:"INSERT",schema:"public",table:"support_messages"},loadConversations)
   .subscribe(status=>{if(status==="CHANNEL_ERROR")toast("Live customer-care updates are unavailable. Refresh to check the inbox.")});
  const timer=setInterval(loadConversations,15000);
  return()=>{clearInterval(timer);supabase.removeChannel(channel)};
 },[approved,session?.user?.id,supabase]);
 useEffect(()=>{
  if(!selected||!approved){setMessages([]);return}
  let active=true;
  supabase.from("support_messages").select("id,sender_id,sender_type,body,created_at").eq("conversation_id",selected.id).order("created_at")
   .then(({data,error})=>{if(!active)return;if(error){toast(`Could not load support messages: ${error.message}`);return}setMessages(data||[])});
  const channel=supabase.channel(`care-thread-${selected.id}`).on("postgres_changes",{event:"INSERT",schema:"public",table:"support_messages",filter:`conversation_id=eq.${selected.id}`},event=>{
   setMessages(current=>current.some(item=>item.id===event.new.id)?current:[...current,event.new].sort((a,b)=>new Date(a.created_at)-new Date(b.created_at)));
  }).subscribe();
  return()=>{active=false;supabase.removeChannel(channel)};
 },[selected?.id,approved,supabase,toast]);
 const availability=async()=>{
  const {data,error}=await supabase.rpc("set_customer_care_availability",{p_is_available:!agent?.is_available});
  if(error){toast(`Could not update availability: ${error.message}`);return}
  setAgent(current=>current?{...current,is_available:data}:current);
 };
 const send=async event=>{
  event.preventDefault();
  if(!selected||!draft.trim()||loading)return;
  setLoading(true);
  const {error}=await supabase.from("support_messages").insert({
   conversation_id:selected.id,sender_id:session.user.id,sender_type:"agent",body:clean(draft).slice(0,2000)
  });
  if(error)toast(`Could not send customer-care reply: ${error.message}`);
  else setDraft("");
  setLoading(false);
 };
 const accept=async()=>{
  if(!selected||loading)return;
  setLoading(true);
  const {error}=await supabase.rpc("accept_support_conversation",{p_conversation_id:selected.id});
  if(error)toast(`Could not accept support request: ${error.message}`);
  else{toast("Support request accepted.");await loadConversations()}
  setLoading(false);
 };
 const resolve=async()=>{
  if(!selected||loading)return;
  setLoading(true);
  const {error}=await supabase.rpc("resolve_support_conversation",{p_conversation_id:selected.id});
  if(error)toast(`Could not resolve support request: ${error.message}`);
  else{toast("Support request resolved.");setSelected(null);setMessages([]);await loadConversations()}
  setLoading(false);
 };
 if(!session)return <main className="landing"><div><span className="eyebrow">CUSTOMER CARE TEAM</span><h1>Help customers with confidence.</h1><p>Customer-care accounts are reviewed by Operations before they can sign in to the support inbox.</p><div className="actions"><button className="primary big" onClick={()=>open("customer_care","signup")}>Apply for customer care</button><button className="secondary big" onClick={()=>open("customer_care","login")}>Customer-care login</button></div></div></main>;
 if(profile?.role!=="customer_care")return <main className="center"><Headphones/><h1>Customer-care account required</h1><p>Sign in with an approved customer-care account to use the private support inbox.</p></main>;
 if(!agent||pending)return <main className="center"><div className="setup"><Clock3/><h1>Application awaiting approval</h1><p>Operations must approve your customer-care application before inbox access is enabled. Signing in does not bypass review.</p></div></main>;
 if(!approved)return <main className="center"><div className="setup"><Headphones/><h1>Customer-care access unavailable</h1><p>Your application is {agent.status}. Contact an administrator if you believe this is an error.</p></div></main>;
 return <main className="page care-inbox-page"><section className="panel"><div className="panel-head"><div><span className="eyebrow">APPROVED CUSTOMER CARE</span><h1>Support inbox</h1><p>Go available to view and manually accept waiting support requests.</p></div><button className={agent.is_available?"secondary":"primary"} onClick={availability}>{agent.is_available?"Go offline":"Go available"}</button></div><div className="care-inbox"><div className="care-thread-list">{conversations.length?conversations.map(conversation=><button key={conversation.id} className={selected?.id===conversation.id?"care-thread selected":"care-thread"} onClick={()=>{setSelected(conversation);setMessages([])}}><b>{conversation.support_status==="waiting"?"Waiting for acceptance":"Assigned support request"}{conversation.needs_attention?" · Needs attention":""}</b><small>{new Date(conversation.updated_at).toLocaleString()}</small></button>):<p>No support requests are waiting or assigned to you.</p>}</div><div className="care-thread-view">{selected?<><p className="care-request-status">Status: {selected.support_status}{selected.needs_attention?" · Awaiting attention":""}</p>{selected.support_status==="waiting"&&<button className="primary" onClick={accept} disabled={loading}>Accept support request</button>}<div className="care-messages">{messages.map(message=><article className={`care-message ${message.sender_type}`} key={message.id}><p>{message.body}</p><small>{message.sender_type==="ai"?"AI assistant":message.sender_type==="agent"?"Customer care":"Customer"} · {time(message.created_at)}</small></article>)}</div>{selected.support_status!=="waiting"&&<><form className="care-form" onSubmit={send}><input aria-label="Customer-care reply" value={draft} onChange={event=>setDraft(event.target.value)} maxLength={2000} placeholder="Reply to customer"/><button className="primary" disabled={loading||!draft.trim()}><Send size={16}/> Send</button></form><button className="secondary" onClick={resolve} disabled={loading}>Resolve support request</button></>}</>:<p>Select a request to preview its conversation. Requests are not accepted automatically.</p>}</div></div></section></main>;
}

function AdminSupportInbox({supabase,toast}){
 const [requests,setRequests]=useState([]),[selected,setSelected]=useState(null),[messages,setMessages]=useState([]),[customer,setCustomer]=useState(null),[draft,setDraft]=useState(""),[loading,setLoading]=useState(false),[loadingMessages,setLoadingMessages]=useState(false);
 const load=async()=>{
  const {data,error}=await supabase.from("support_conversations")
   .select("id,customer_id,support_status,needs_attention,human_requested_at,updated_at")
   .not("human_requested_at","is",null)
   .neq("support_status","resolved").order("updated_at",{ascending:false}).limit(50);
  if(error){toast(`Could not load support requests: ${error.message}`);return}
  setRequests(data||[]);
  setSelected(current=>current?(data?.find(row=>row.id===current.id)||null):null);
 };
 useEffect(()=>{
  void load();
  const channel=supabase.channel("admin-support-requests")
   .on("postgres_changes",{event:"*",schema:"public",table:"support_conversations"},load)
   .subscribe(status=>{if(status==="CHANNEL_ERROR")toast("Live support-request updates are unavailable. Refresh the admin dashboard.")});
  const timer=setInterval(load,15000);
  return()=>{clearInterval(timer);supabase.removeChannel(channel)};
 },[supabase,toast]);
 useEffect(()=>{
  if(!selected){setMessages([]);setCustomer(null);return}
  let active=true;
  setLoadingMessages(true);setMessages([]);
  Promise.all([
   supabase.from("support_messages").select("id,sender_id,sender_type,body,created_at").eq("conversation_id",selected.id).order("created_at",{ascending:true}).limit(100),
   supabase.from("profiles").select("id,full_name,email,phone").eq("id",selected.customer_id).maybeSingle()
  ]).then(([messageResult,profileResult])=>{
   if(!active)return;
   if(messageResult.error){toast(`Could not load support messages: ${messageResult.error.message}`);return}
   if(profileResult.error){toast(`Could not load customer details: ${profileResult.error.message}`);return}
   setMessages(messageResult.data||[]);setCustomer(profileResult.data||null);
  }).finally(()=>{if(active)setLoadingMessages(false)});
  return()=>{active=false};
 },[selected?.id,supabase,toast]);
 const accept=async()=>{
  if(!selected||loading)return;
  setLoading(true);
  const {error}=await supabase.rpc("accept_support_conversation",{p_conversation_id:selected.id});
  if(error)toast(`Could not accept support request: ${error.message}`);
  else{toast("Support request accepted.");await load()}
  setLoading(false);
 };
 const send=async event=>{
  event.preventDefault();
  if(!selected||!draft.trim()||loading)return;
  setLoading(true);
  const {data:userResult}=await supabase.auth.getUser();
  if(!userResult?.user){toast("Your admin session expired. Sign in again.");setLoading(false);return}
  const {error}=await supabase.from("support_messages").insert({conversation_id:selected.id,sender_id:userResult.user.id,sender_type:"agent",body:clean(draft).slice(0,2000)});
  if(error)toast(`Could not send customer-care reply: ${error.message}`);
  else{
   setDraft("");
   const {data,error:messageError}=await supabase.from("support_messages").select("id,sender_id,sender_type,body,created_at").eq("conversation_id",selected.id).order("created_at",{ascending:true}).limit(100);
   if(messageError)toast(`Reply sent, but conversation refresh failed: ${messageError.message}`);
   else setMessages(data||[]);
  }
  setLoading(false);
 };
 const resolve=async()=>{
  if(!selected||loading)return;
  setLoading(true);
  const {error}=await supabase.rpc("resolve_support_conversation",{p_conversation_id:selected.id});
  if(error)toast(`Could not resolve support request: ${error.message}`);
  else{toast("Support request resolved.");setSelected(null);await load()}
  setLoading(false);
 };
 return <section className="panel care-applications" id="admin-support"><span className="eyebrow">CUSTOMER CARE</span><h2>Support requests</h2><p>Review each request and choose when to accept it. AI replies do not count as human responses.</p><div className="care-inbox"><div className="care-thread-list">{requests.length?requests.map(request=><button key={request.id} className={selected?.id===request.id?"care-thread selected":"care-thread"} onClick={()=>setSelected(request)}><b>{request.support_status}{request.needs_attention?" · Needs attention":""}</b><small>{request.id.slice(0,8)} · {new Date(request.updated_at).toLocaleString()}</small></button>):<p>No open support requests.</p>}</div><div className="care-thread-view">{selected?<><p className="care-request-status">{loadingMessages?"Loading conversation…":`Customer: ${customer?.full_name||customer?.email||selected.customer_id}`}<br/>Status: {selected.support_status}{selected.needs_attention?" · Awaiting attention":""}</p>{selected.support_status==="waiting"&&<button className="primary" onClick={accept} disabled={loading}>Accept support request</button>}{loadingMessages?<p role="status">Loading messages…</p>:<div className="care-messages">{messages.map(message=><article className={`care-message ${message.sender_type}`} key={message.id}><p>{message.body}</p><small>{message.sender_type==="ai"?"AI assistant":message.sender_type==="agent"?"Customer care":"Customer"} · {time(message.created_at)}</small></article>)}</div>}{selected.support_status!=="waiting"&&<><form className="care-form" onSubmit={send}><input aria-label="Customer-care reply" value={draft} onChange={event=>setDraft(event.target.value)} maxLength={2000} placeholder="Reply to customer"/><button className="primary" disabled={loading||!draft.trim()}><Send size={16}/> Send</button></form><button className="secondary" onClick={resolve} disabled={loading}>Resolve support request</button></>}</>:<p>Select a support request to load its conversation. No request is opened or assigned automatically.</p>}</div></div></section>;
}

export function CustomerCareAdmin({supabase,toast}){
 const [applications,setApplications]=useState([]);
 const load=async()=>{
  const {data,error}=await supabase.from("customer_care_agents")
   .select("id,status,created_at,profile:profiles!customer_care_agents_id_fkey(full_name,email,phone)")
   .eq("status","pending").order("created_at",{ascending:false});
  if(error){toast(`Could not load customer-care applications: ${error.message}`);return}
  setApplications(data||[]);
 };
 useEffect(()=>{
  void load();
  const channel=supabase.channel("admin-customer-care-applications")
   .on("postgres_changes",{event:"*",schema:"public",table:"customer_care_agents"},load)
   .subscribe(status=>{if(status==="CHANNEL_ERROR")toast("Live care-application updates are unavailable. Refresh the admin dashboard.")});
  return()=>supabase.removeChannel(channel);
 },[supabase,toast]);
 const decide=async(id,approved)=>{
  const {error}=await supabase.rpc("approve_customer_care_agent",{p_agent_id:id,p_approved:approved});
  if(error){toast(`Could not update customer-care application: ${error.message}`);return}
  toast(approved?"Customer-care application approved.":"Customer-care application rejected.");
  await load();
 };
 return <><section className="panel care-applications"><span className="eyebrow">CUSTOMER CARE</span><h2>Customer-care applications</h2>{applications.length?applications.map(application=><article className="job" key={application.id}><b>{application.profile?.full_name||"Customer-care applicant"}</b><p>{application.profile?.email||"Email unavailable"} · {application.profile?.phone||"Phone unavailable"}</p><div className="actions"><button className="primary" onClick={()=>decide(application.id,true)}>Approve</button><button className="secondary" onClick={()=>decide(application.id,false)}>Reject</button></div></article>):<p>No pending customer-care applications.</p>}</section><AdminSupportInbox supabase={supabase} toast={toast}/></>;
}
