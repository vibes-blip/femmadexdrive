import React,{useEffect,useRef,useState} from "react";
import {Mic,Navigation,Package,Volume2,X} from "lucide-react";
import {voiceCommand} from "./voiceCommands.js";
import "./voice-control.css";

const welcomeMessage="Welcome to FemmaDex. Choose us for convenient parcel delivery, delivery tracking, and helpful FemmaDexCare support. Select small and medium parcels, bulky items, or fast delivery, which has a two-hour target after a rider accepts it. Tell me what you would like to do.";
const feminineVoiceNames=/female|woman|zira|samantha|susan|karen|tessa|victoria|ava|salli|joanna|aria|jenny|natasha|linda|moira|fiona|serena|allison|emma|amy|olivia|google uk english female/i;

function recognizeSpeech(){
 if(typeof window==="undefined")return null;
 return window.SpeechRecognition||window.webkitSpeechRecognition||null;
}

function speakMessage(text){
 const synthesis=window.speechSynthesis;
 if(!synthesis||!window.SpeechSynthesisUtterance)return;
 synthesis.cancel();
 const utterance=createUtterance(text,synthesis);
 synthesis.speak(utterance);
}

function createUtterance(text,synthesis){
 const utterance=new window.SpeechSynthesisUtterance(text);
 const language=navigator.language||"en-US";
 const matchingLanguage=synthesis.getVoices().filter(voice=>voice.lang.toLowerCase().startsWith(language.split("-")[0].toLowerCase()));
 utterance.voice=matchingLanguage.find(voice=>feminineVoiceNames.test(voice.name))||matchingLanguage[0]||null;
 utterance.lang=language;
 utterance.rate=0.96;
 return utterance;
}

export default function VoiceControl(){
 const [listening,setListening]=useState(false),[message,setMessage]=useState("Tap the microphone to hear how FemmaDex can help, then say a page name or booking detail."),[open,setOpen]=useState(true);
 const recognitionRef=useRef(null);
 const sessionRef=useRef(0);

 const stop=()=>{
  sessionRef.current+=1;
  recognitionRef.current?.stop();
  recognitionRef.current=null;
  window.speechSynthesis?.cancel();
  setListening(false);
 };

 useEffect(()=>()=>{recognitionRef.current?.stop();window.speechSynthesis?.cancel()},[]);

 const runCommand=transcript=>{
  const command=voiceCommand(transcript);
  if(command.type==="stop"){
   stop();
   setMessage(command.message);
   setOpen(false);
   return;
  }
  const reply=command.type==="fill"
   ?command.field==="pickup"||command.field==="dropoff"
    ?`Added ${command.field==="pickup"?"pickup":"destination"} text. Choose a map suggestion to confirm its location.`
    :"Added that detail to the booking form."
   :command.message;
  setMessage(reply);
  speakMessage(reply);
  if(command.type==="navigate"){
   history.pushState({},"",command.path);
   dispatchEvent(new PopStateEvent("popstate"));
   return;
  }
  if(command.type==="support"){
   dispatchEvent(new Event("fdd-open-care"));
   return;
  }
  if(command.type==="fill"){
   try{
    const detail={field:command.field,value:command.value};
    if(document.getElementById("customer-booking-form"))dispatchEvent(new CustomEvent("fdd-voice-fill",{detail}));
    else sessionStorage.setItem("fddVoiceBookingField",JSON.stringify(detail));
   }catch(error){const errorMessage=`Could not save that booking detail: ${error.message}`;setMessage(errorMessage);speakMessage(errorMessage)}
   return;
  }
 };

 const startRecognition=(Recognition,sessionId)=>{
  if(sessionRef.current!==sessionId)return;
  if(!Recognition){
   setListening(false);
   setMessage(`${welcomeMessage} Voice recognition is not supported in this browser. Try the latest Chrome or Safari over HTTPS.`);
   return;
  }
  const recognition=new Recognition();
  recognitionRef.current=recognition;
  recognition.lang=navigator.language||"en-US";
  recognition.interimResults=false;
  recognition.maxAlternatives=4;
  recognition.onstart=()=>{if(sessionRef.current===sessionId){setListening(true);setMessage("Listening… say a page name or booking field and its value.")}};
  recognition.onresult=event=>{
   if(sessionRef.current!==sessionId)return;
   recognition.stop();
   recognitionRef.current=null;
   setListening(false);
   const alternatives=Array.from(event.results?.[0]||[]);
   const candidates=alternatives.map(result=>String(result.transcript||"").trim()).filter(Boolean);
   const transcript=candidates.find(candidate=>voiceCommand(candidate).type!=="unknown")||candidates[0]||"";
   if(!transcript){setMessage("I didn’t catch that. Tap the microphone and try again.");return}
   setMessage(`Heard: “${transcript}”`);
   runCommand(transcript);
  };
  recognition.onerror=event=>{
   if(sessionRef.current!==sessionId)return;
   const errors={
    "not-allowed":"Microphone access was denied. Allow microphone access in your browser settings.",
    "service-not-allowed":"Speech recognition is blocked by this browser or device.",
    "no-speech":"No speech was detected. Tap the microphone and try again.",
    "network":"Speech recognition is unavailable because of a network problem."
   };
   setMessage(errors[event.error]||`Voice control could not start: ${event.error||"unknown error"}.`);
   setListening(false);
   recognitionRef.current=null;
  };
  recognition.onend=()=>{if(sessionRef.current===sessionId){setListening(false);recognitionRef.current=null}};
  try{recognition.start()}
  catch(error){if(sessionRef.current===sessionId){recognitionRef.current=null;setListening(false);setMessage(`Voice control could not start: ${error.message}`)}}
 };

 const listen=()=>{
  if(listening||window.speechSynthesis?.speaking||window.speechSynthesis?.pending){stop();return}
  const sessionId=++sessionRef.current;
  const Recognition=recognizeSpeech();
  setListening(true);
  setMessage(welcomeMessage);
  const synthesis=window.speechSynthesis;
  if(!synthesis||!window.SpeechSynthesisUtterance){
   if(Recognition)startRecognition(Recognition,sessionId);
   else{
    setListening(false);
    setMessage(`${welcomeMessage} Voice recognition is not supported in this browser. Try the latest Chrome or Safari over HTTPS.`);
   }
   return;
  }
  const utterance=createUtterance(welcomeMessage,synthesis);
  utterance.onend=()=>startRecognition(Recognition,sessionId);
  utterance.onerror=()=>{
   if(sessionRef.current!==sessionId)return;
   setMessage(`${welcomeMessage} Audio greeting could not play. You can still use voice commands.`);
   startRecognition(Recognition,sessionId);
  };
  try{synthesis.speak(utterance)}
  catch(error){
   setMessage(`${welcomeMessage} Audio greeting could not play: ${error.message}`);
   startRecognition(Recognition,sessionId);
  }
 };

 if(!open)return <aside className="voice-control" aria-label="Website voice control">
  <button type="button" className="voice-control-button" onClick={()=>setOpen(true)} aria-label="Open voice control">
   <Mic size={20}/><span>Voice control</span>
  </button>
 </aside>;

 return <aside className="voice-control" aria-label="Website voice control">
  <section className="voice-control-panel">
   <div className="voice-control-heading"><span><Volume2 size={17}/> Voice control</span><div className="voice-control-actions"><button type="button" onClick={()=>setMessage("Say “book delivery”, “track package”, “pickup [address]”, or “package details [items]”.")} aria-label="Show voice commands"><Navigation size={15}/></button><button type="button" onClick={()=>{stop();setOpen(false)}} aria-label="Close voice control"><X size={16}/></button></div></div>
   <p role="status" aria-live="polite">{message}</p>
   <div className="voice-control-examples"><span><Package size={14}/> Say “recipient name Ada”</span><span>“delivery category fast”</span></div>
   <small>Tap the mic to hear a welcome in a feminine voice when available. Say “FemmaDex, hi” for help, or “stop and close” to end voice control; you can also close this panel with the X. Voice fills details only, so review your booking and confirm the map locations yourself.</small>
  </section>
  <button type="button" className={`voice-control-button${listening?" listening":""}`} onClick={listen} aria-label={listening||window.speechSynthesis?.speaking?"Stop voice control":"Start voice control"} aria-pressed={listening||Boolean(window.speechSynthesis?.speaking)}>
   {listening||window.speechSynthesis?.speaking?<X size={20}/>:<Mic size={20}/>}<span>{listening?"Listening":window.speechSynthesis?.speaking?"Stop voice":"Voice control"}</span>
  </button>
 </aside>;
}
