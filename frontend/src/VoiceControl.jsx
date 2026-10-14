import React,{useEffect,useRef,useState} from "react";
import {Check,Mic,MicOff,Navigation,Package,Volume2,X} from "lucide-react";
import {greetingPhrase,voiceCommand,wakeRequest} from "./voiceCommands.js";
import "./voice-control.css";

const feminineVoiceNames=/female|woman|zira|samantha|susan|karen|tessa|victoria|ava|salli|joanna|aria|jenny|natasha|linda|moira|fiona|serena|allison|emma|amy|olivia|google uk english female/i;
const VOICE_GREETING_KEY="fddVoiceGreetingSeen";
const voiceLanguages=[
 ["en-NG","English (Nigeria)"],["en-US","English (US)"],["yo-NG","Yoruba"],["ha-NG","Hausa"],["ig-NG","Igbo"],
 ["fr-FR","French"],["es-ES","Spanish"],["ar-SA","Arabic"],["pt-PT","Portuguese"],["sw-KE","Swahili"]
];

function recognizeSpeech(){
 if(typeof window==="undefined")return null;
 return window.SpeechRecognition||window.webkitSpeechRecognition||null;
}

function createUtterance(text,synthesis,language){
 const utterance=new window.SpeechSynthesisUtterance(text);
 const locale=language||navigator.language||"en-US";
 const matchingLanguage=synthesis.getVoices().filter(voice=>voice.lang.toLowerCase().startsWith(locale.split("-")[0].toLowerCase()));
 utterance.voice=matchingLanguage.find(voice=>feminineVoiceNames.test(voice.name))||matchingLanguage[0]||null;
 utterance.lang=locale;
 utterance.rate=0.96;
 return utterance;
}

function speakMessage(text,language,onEnd){
 const synthesis=window.speechSynthesis;
 if(!synthesis||!window.SpeechSynthesisUtterance){onEnd?.();return}
 synthesis.cancel();
 const utterance=createUtterance(text,synthesis,language);
 utterance.onend=()=>onEnd?.();
 utterance.onerror=()=>onEnd?.();
 synthesis.speak(utterance);
}

function voiceErrorMessage(error){
 const errors={
  "NotAllowedError":"Microphone access was denied. Allow it in the browser prompt or site settings, then try again.",
  "NotFoundError":"No microphone was found on this device.",
  "NotReadableError":"The microphone is busy in another application. Close that app and try again.",
  "SecurityError":"Microphone access requires a secure HTTPS website."
 };
 return errors[error?.name]||`Microphone permission could not be requested: ${error?.message||"unknown error"}.`;
}

export default function VoiceControl(){
 const supportedLanguage=voiceLanguages.find(([code])=>code.toLowerCase()===String(navigator.language||"").toLowerCase())?.[0]||"en-NG";
 const [open,setOpen]=useState(()=>{try{return !localStorage.getItem(VOICE_GREETING_KEY)}catch{return true}}),[listening,setListening]=useState(false),[wakeEnabled,setWakeEnabled]=useState(false);
 const [message,setMessage]=useState("Hi! I’m FemmaDex. Need help? Tap Allow microphone, then say “FemmaDex, hi” and I’ll wake up. You can always type instead.");
 const [language,setLanguage]=useState(supportedLanguage),[transcript,setTranscript]=useState("");
 const recognitionRef=useRef(null),sessionRef=useRef(0),wakeEnabledRef=useRef(false),awaitingEditRef=useRef(false),restartTimerRef=useRef(null),sleepTimerRef=useRef(null),conversationAwakeRef=useRef(false);
 const openRef=useRef(open);
 openRef.current=open;
 useEffect(()=>{
  if(!open)return;
  try{localStorage.setItem(VOICE_GREETING_KEY,"1")}catch{setMessage("Welcome! I’m FemmaDex. Tap Allow microphone, then say “FemmaDex, hi” if you need help. You can always type instead. This greeting may appear again if browser storage is unavailable.")}
 },[open]);
 const clearSleepTimer=()=>{clearTimeout(sleepTimerRef.current);sleepTimerRef.current=null};
 const sleepAfterSilence=(sessionId,selectedLanguage)=>{
  clearSleepTimer();
  sleepTimerRef.current=setTimeout(()=>{
   if(sessionRef.current!==sessionId||!wakeEnabledRef.current)return;
   conversationAwakeRef.current=false;
   setOpen(false);
   setMessage("Voice is resting after 10 seconds of silence. The microphone now listens only for “FemmaDex” and a greeting.");
   stopRecognition();
   scheduleWakeRestart(sessionId,selectedLanguage,250);
  },10_000);
 };

 const stopRecognition=()=>{
  clearTimeout(restartTimerRef.current);
  restartTimerRef.current=null;
  const recognition=recognitionRef.current;
  recognitionRef.current=null;
  try{recognition?.stop()}catch(error){if(error.name!=="InvalidStateError")setMessage(`Voice recognition could not stop: ${error.message}`)}
  setListening(false);
 };
 const scheduleWakeRestart=(sessionId,selectedLanguage,delay)=>{
  clearTimeout(restartTimerRef.current);
  restartTimerRef.current=setTimeout(()=>startWakeListening(sessionId,selectedLanguage),delay);
 };

 const stop=()=>{
  sessionRef.current+=1;
  wakeEnabledRef.current=false;
  conversationAwakeRef.current=false;
  clearSleepTimer();
  setWakeEnabled(false);
  awaitingEditRef.current=false;
  stopRecognition();
  window.speechSynthesis?.cancel();
  setTranscript("");
  setMessage("Voice control stopped. Tap the microphone to enable it again.");
 };

 const startWakeListening=(sessionId,selectedLanguage)=>{
  if(sessionRef.current!==sessionId||!wakeEnabledRef.current||awaitingEditRef.current)return;
  const Recognition=recognizeSpeech();
  if(!Recognition){
   wakeEnabledRef.current=false;
   setWakeEnabled(false);
   setListening(false);
   setMessage("Voice recognition is not supported in this browser. Try an up-to-date browser over HTTPS.");
   return;
  }
  const recognition=new Recognition();
  recognitionRef.current=recognition;
  recognition.lang=selectedLanguage;
  recognition.continuous=true;
  recognition.interimResults=true;
  recognition.maxAlternatives=4;
  recognition.onstart=()=>{if(sessionRef.current===sessionId){setListening(true);if(!conversationAwakeRef.current)setMessage("Wake phrase ready. Say “FemmaDex, hi” to open voice help.")}};
  recognition.onresult=event=>{
   if(sessionRef.current!==sessionId)return;
   if(conversationAwakeRef.current)sleepAfterSilence(sessionId,selectedLanguage);
   const results=Array.from(event.results||[]).slice(event.resultIndex||0).filter(result=>result.isFinal);
   for(const result of results){
    const candidates=Array.from(result).map(item=>String(item.transcript||"").trim()).filter(Boolean);
    const heard=candidates[0]||"";
    if(!heard)continue;
    const stopCommand=candidates.find(candidate=>voiceCommand(candidate,selectedLanguage).type==="stop");
    if(stopCommand){stop();setOpen(false);return}
    const request=wakeRequest(heard);
    if(!request&&!conversationAwakeRef.current)continue;
    if(request){
     conversationAwakeRef.current=true;
     clearSleepTimer();
     setOpen(true);
     if(request.text){
      awaitingEditRef.current=true;
      setTranscript(request.text);
      setMessage("I heard this request. Edit it if needed, then tap Send voice request.");
      stopRecognition();
      return;
     }
     const greeting=voiceCommand(greetingPhrase(selectedLanguage),selectedLanguage).message;
     setMessage(greeting);
     awaitingEditRef.current=true;
     speakMessage(greeting,selectedLanguage,()=>{awaitingEditRef.current=false;sleepAfterSilence(sessionId,selectedLanguage);startWakeListening(sessionId,selectedLanguage)});
     stopRecognition();
     return;
    }
    clearSleepTimer();
    awaitingEditRef.current=true;
    setTranscript(heard);
    setMessage("I heard this request. Edit it if needed, then tap Send voice request.");
    stopRecognition();
    return;
   }
  };
  recognition.onerror=event=>{
   if(sessionRef.current!==sessionId)return;
   const errors={
    "not-allowed":"Microphone access was denied. Allow it in browser settings, then tap the microphone to retry.",
    "service-not-allowed":"Speech recognition is blocked by this browser or device.",
    "no-speech":"No speech was detected. Wake phrase listening will resume.",
    "network":"Speech recognition is unavailable because of a network problem."
   };
   setMessage(errors[event.error]||`Voice recognition could not continue: ${event.error||"unknown error"}.`);
   setListening(false);
   recognitionRef.current=null;
   if(event.error==="no-speech")scheduleWakeRestart(sessionId,selectedLanguage,700);
   else if(event.error!=="not-allowed"&&event.error!=="service-not-allowed")scheduleWakeRestart(sessionId,selectedLanguage,1200);
   else{wakeEnabledRef.current=false;setWakeEnabled(false)}
  };
  recognition.onend=()=>{
   if(sessionRef.current!==sessionId)return;
   recognitionRef.current=null;
   setListening(false);
   if(wakeEnabledRef.current&&!awaitingEditRef.current)scheduleWakeRestart(sessionId,selectedLanguage,250);
  };
  try{recognition.start()}
  catch(error){
   if(sessionRef.current===sessionId){
    recognitionRef.current=null;
    setListening(false);
    setMessage(`Voice recognition could not start: ${error.message}`);
   }
  }
 };

 const enableWakeListening=async()=>{
  if(!recognizeSpeech()){
   setMessage("Voice recognition is not supported in this browser. Try an up-to-date browser over HTTPS.");
   return;
  }
  if(!navigator.mediaDevices?.getUserMedia){
   setMessage("Microphone permission is unavailable. Use a supported browser over HTTPS.");
   return;
  }
  try{
   setMessage("Your browser will ask for microphone permission. The microphone is used to listen for “FemmaDex, hi”.");
   const stream=await navigator.mediaDevices.getUserMedia({audio:true});
   stream.getTracks().forEach(track=>track.stop());
   const sessionId=++sessionRef.current;
   wakeEnabledRef.current=true;
   conversationAwakeRef.current=false;
   clearSleepTimer();
   awaitingEditRef.current=false;
   setWakeEnabled(true);
   setOpen(false);
   setMessage("Wake phrase ready. Say “FemmaDex, hi” to open voice help.");
   startWakeListening(sessionId,language);
  }catch(error){setMessage(voiceErrorMessage(error))}
 };

 const submitTranscript=event=>{
  event.preventDefault();
  if(!transcript.trim())return;
  const request=transcript.trim();
  const command=voiceCommand(request,language);
  if(command.type==="stop"){stop();setOpen(false);return}
  if(command.type==="unknown"){
   stop();
   setOpen(false);
   dispatchEvent(new CustomEvent("fdd-care-voice-message",{detail:{text:request}}));
   return;
  }
  awaitingEditRef.current=true;
  setTranscript("");
  const reply=command.type==="fill"
   ?command.field==="pickup"||command.field==="dropoff"
    ?`Added ${command.field==="pickup"?"pickup":"destination"} text. Choose a map suggestion to confirm its location.`
    :"Added that detail to the booking form."
   :command.message;
  setMessage(reply);
  const sessionId=sessionRef.current,selectedLanguage=language;
  const resume=()=>{awaitingEditRef.current=false;sleepAfterSilence(sessionId,selectedLanguage);startWakeListening(sessionId,selectedLanguage)};
  if(command.type==="navigate"){
   history.pushState({},"",command.path);
   dispatchEvent(new PopStateEvent("popstate"));
  }else if(command.type==="support"){
   dispatchEvent(new Event("fdd-open-care"));
  }else if(command.type==="fill"){
   try{
    const detail={field:command.field,value:command.value};
    if(document.getElementById("customer-booking-form"))dispatchEvent(new CustomEvent("fdd-voice-fill",{detail}));
    else sessionStorage.setItem("fddVoiceBookingField",JSON.stringify(detail));
   }catch(error){setMessage(`Could not save that booking detail: ${error.message}`)}
  }
  speakMessage(reply,selectedLanguage,resume);
 };

 const changeLanguage=event=>{
  const selectedLanguage=event.target.value;
  setLanguage(selectedLanguage);
  if(!wakeEnabledRef.current)return;
  clearSleepTimer();
  const sessionId=++sessionRef.current;
  stopRecognition();
  if(conversationAwakeRef.current)sleepAfterSilence(sessionId,selectedLanguage);
  startWakeListening(sessionId,selectedLanguage);
 };

 const togglePanel=()=>{
  if(!wakeEnabledRef.current){setOpen(true);return}
  setOpen(value=>!value);
 };

 useEffect(()=>()=>{sessionRef.current+=1;wakeEnabledRef.current=false;clearTimeout(restartTimerRef.current);clearSleepTimer();recognitionRef.current?.stop();window.speechSynthesis?.cancel()},[]);

 return <aside className="voice-control" aria-label="Website voice control">
  {open&&<section className="voice-control-panel" aria-label="Voice control" role="region">
   <div className="voice-control-heading"><span><Volume2 size={17}/> FemmaDex voice</span><div className="voice-control-actions">
    {wakeEnabled&&<button type="button" onClick={()=>{stop();setOpen(false)}} aria-label="Stop and close voice control"><MicOff size={16}/></button>}
    <button type="button" onClick={()=>setMessage("Say “FemmaDex, hi” to wake me, then edit the recognized request before sending it.")} aria-label="Show voice help"><Navigation size={15}/></button>
    <button type="button" onClick={()=>{if(wakeEnabledRef.current)stop();setOpen(false)}} aria-label={wakeEnabled?"Stop voice and close":"Close voice panel"}><X size={16}/></button>
   </div></div>
   {!wakeEnabled?<div className="voice-control-permission">
    <p role="status" aria-live="polite">{message} Your browser will ask permission before the microphone is used. Once enabled, listening stays active until you say “stop and close” or tap the stop button in this panel.</p>
    <label htmlFor="voice-language">Speech language</label>
    <select id="voice-language" value={language} onChange={changeLanguage}>{voiceLanguages.map(([code,label])=><option key={code} value={code}>{label}</option>)}</select>
    <button type="button" className="voice-control-allow" onClick={enableWakeListening}><Mic size={16}/> Allow microphone and enable wake phrase</button>
   </div>:<>
    <p role="status" aria-live="polite">{message}</p>
    <label htmlFor="voice-language">Speech language</label>
    <select id="voice-language" value={language} onChange={changeLanguage}>{voiceLanguages.map(([code,label])=><option key={code} value={code}>{label}</option>)}</select>
    <div className="voice-control-examples"><span><Package size={14}/> “book a delivery”</span><span>“track my parcel” · “pickup from Ikeja”</span></div>
    {transcript&&<form className="voice-control-transcript" onSubmit={submitTranscript}>
     <label htmlFor="voice-transcript">Heard request — edit before sending</label>
     <textarea id="voice-transcript" value={transcript} onChange={event=>{awaitingEditRef.current=true;stopRecognition();setTranscript(event.target.value)}} rows={3}/>
     <button type="submit"><Check size={16}/> Send voice request</button>
    </form>}
    <small>{listening?"Listening for “FemmaDex, hi”.":'Wake phrase listening is paused.'} Speech recognition uses your selected language. Review and edit the transcript before sending; voice never submits a quote, order, or payment.</small>
   </>}
  </section>}
  <button type="button" className={`voice-control-button${listening?" listening":""}`} onClick={togglePanel}
   aria-label={wakeEnabled?(open?"Hide voice panel":"Show voice panel"):"Open voice permission and language settings"}
   aria-pressed={listening} title={wakeEnabled?(listening?"Listening for “FemmaDex, hi”":"Voice wake phrase is paused"):"Enable voice control"}>
   {!wakeEnabled?<Mic size={21}/>:listening?<Mic size={21}/>:<MicOff size={21}/>}
  </button>
 </aside>;
}
