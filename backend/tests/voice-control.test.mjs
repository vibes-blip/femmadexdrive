import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {voiceCommand,wakeRequest} from "../../frontend/src/voiceCommands.js";
import {feminineVoice} from "../../frontend/src/speech-voice.js";

const voiceUi=readFileSync(new URL("../../frontend/src/VoiceControl.jsx",import.meta.url),"utf8");
const careUi=readFileSync(new URL("../../frontend/src/CustomerCare.jsx",import.meta.url),"utf8");
const careSpeech=readFileSync(new URL("../netlify/functions/care-speech.mjs",import.meta.url),"utf8");

test("spoken stop and close commands end recognition and hide the voice panel",()=>{
 for(const phrase of ["stop","stop and close","close voice control","please stop listening","cancel microphone"]){
  assert.equal(voiceCommand(phrase).type,"stop",phrase);
 }
 assert.match(voiceUi,/setOpen\(false\)/);
 assert.match(voiceUi,/onClick=\{\(\)=>\{stop\(\);setOpen\(false\)\}\}/);
 assert.match(voiceUi,/aria-label="Stop and close voice control"/);
 assert.match(voiceUi,/aria-label=\{wakeEnabled\?"Stop voice and close":"Close voice panel"\}/);
});

test("FemmaDex greeting returns a spoken conversational welcome",()=>{
 const greeting=voiceCommand("FemmaDex, hi");
 assert.equal(greeting.type,"reply");
 assert.match(greeting.message,/Hi!/);
 assert.match(greeting.message,/book or track a delivery/);
 assert.match(voiceUi,/command\.type==="unknown"\|\|command\.type==="reply"/);
 assert.match(voiceUi,/fdd-care-voice-message/);
});

test("website entry speaks a welcome without enabling the microphone",()=>{
 assert.match(voiceUi,/const welcomeGreeting="Welcome to FemmaDexDrive\. How may I help you\?/);
 assert.match(voiceUi,/speakMessage\(welcomeGreeting,supportedLanguage/);
 assert.match(voiceUi,/const AUTO_GREETING_KEY="fddAutoGreetingPlayed"/);
 assert.match(voiceUi,/if\(localStorage\.getItem\(AUTO_GREETING_KEY\)\)return/);
 assert.match(voiceUi,/localStorage\.setItem\(AUTO_GREETING_KEY,"1"\)/);
 assert.match(voiceUi,/Play welcome/);
 assert.match(voiceUi,/Microphone access is only requested if you enable voice control/);
 assert.match(voiceUi,/Automatic welcome is off because browser storage is unavailable/);
});

test("wake phrase listens only after explicit microphone approval and opens an editable request",()=>{
 assert.deepEqual(wakeRequest("FemmaDex, hi"),{text:""});
 assert.deepEqual(wakeRequest("FemmaDex hi book delivery"),{text:"book delivery"});
 assert.deepEqual(wakeRequest("FemmaDex bawo ni"),{text:""});
 assert.deepEqual(wakeRequest("FemmaDex buenos días"),{text:""});
 assert.deepEqual(wakeRequest("Hey FemmaDex, good evening"),{text:""});
 assert.equal(wakeRequest("book delivery"),null);
 assert.match(voiceUi,/getUserMedia\(\{audio:true\}\)/);
 assert.match(voiceUi,/Allow microphone and enable wake phrase/);
 assert.match(voiceUi,/recognition\.continuous=true/);
 assert.match(voiceUi,/setOpen\(true\)/);
 assert.match(voiceUi,/Heard request — edit before sending/);
 assert.match(voiceUi,/Send voice request/);
 assert.match(voiceUi,/fdd-care-voice-message/);
 assert.match(voiceUi,/voiceLanguages/);
 assert.match(voiceUi,/openRef\.current/);
});

test("voice and chat launchers are icon-only and conversational languages are normalized",()=>{
 assert.match(voiceUi,/<Mic size=\{21\}\/>/);
 assert.match(careUi,/aria-label=\{open\?"Close FemmaDexCare":"Open FemmaDexCare"\}/);
 assert.doesNotMatch(careUi,/<span>FemmaDexCare<\/span>/);
 assert.match(careUi,/fdd-care-voice-message/);
 assert.match(careUi,/pendingVoiceMessage/);
 assert.match(careUi,/feminineVoice\(/);
 assert.equal(voiceCommand("Hola","es-ES").type,"reply");
 assert.equal(voiceCommand("Bonjour","fr-FR").type,"reply");
 assert.equal(voiceCommand("Olá","pt-PT").type,"reply");
 assert.equal(voiceCommand("Mo fẹ fi ẹru ránṣẹ́","yo-NG").path,"/book");
});

test("browser speech uses a recognized feminine voice and never silently selects a male voice",()=>{
 const voices=[
  {name:"Microsoft David Desktop",lang:"en-US"},
  {name:"Microsoft Zira Desktop Natural",lang:"en-US"},
  {name:"Google UK English Female",lang:"en-GB"}
 ];
 assert.equal(feminineVoice(voices,"en-US")?.name,"Microsoft Zira Desktop Natural");
 assert.equal(feminineVoice(voices,"en-NG")?.name,"Microsoft Zira Desktop Natural");
 assert.equal(feminineVoice([{name:"Microsoft David Desktop",lang:"en-US"}],"en-US"),null);
 assert.match(voiceUi,/feminineVoice\(synthesis\.getVoices\(\),locale\)/);
 assert.match(voiceUi,/if\(!utterance\.voice\)return null/);
 assert.match(careUi,/No feminine browser voice is installed/);
 assert.match(careSpeech,/voiceName:"Aoede"/);
 assert.match(careSpeech,/warm, natural feminine Nigerian English voice/);
 assert.match(careSpeech,/no echo, reverb, music, or sound effects/);
});
