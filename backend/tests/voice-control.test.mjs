import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {voiceCommand} from "../../frontend/src/voiceCommands.js";

const voiceUi=readFileSync(new URL("../../frontend/src/VoiceControl.jsx",import.meta.url),"utf8");

test("spoken stop and close commands end recognition and hide the voice panel",()=>{
 for(const phrase of ["stop","stop and close","close voice control","please stop listening","cancel microphone"]){
  assert.equal(voiceCommand(phrase).type,"stop",phrase);
 }
 assert.match(voiceUi,/setOpen\(false\)/);
 assert.match(voiceUi,/onClick=\{\(\)=>\{stop\(\);setOpen\(false\)\}\}/);
 assert.match(voiceUi,/aria-label="Close voice control"/);
});

test("FemmaDex greeting returns a spoken conversational welcome",()=>{
 const greeting=voiceCommand("FemmaDex, hi");
 assert.equal(greeting.type,"reply");
 assert.match(greeting.message,/Hi!/);
 assert.match(greeting.message,/book or track a delivery/);
 assert.match(voiceUi,/speakMessage\(reply\)/);
});
