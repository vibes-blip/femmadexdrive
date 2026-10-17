const feminineVoiceNames=/female|woman|zira|samantha|susan|karen|tessa|victoria|ava|salli|joanna|aria|jenny|natasha|linda|moira|fiona|serena|allison|emma|amy|olivia|google (?:uk|us) english(?: female)?|microsoft (?:zira|aria|jenny)/i;
const naturalVoiceNames=/natural|neural|online|premium/i;

export function feminineVoice(voices,language){
 const available=(Array.isArray(voices)?voices:[]).filter(voice=>feminineVoiceNames.test(voice.name||""));
 const locale=String(language||"").toLowerCase();
 const languageCode=locale.split("-")[0];
 return available.sort((left,right)=>{
  const score=voice=>
   (voice.lang?.toLowerCase()===locale?4:voice.lang?.toLowerCase().startsWith(`${languageCode}-`)?2:0)+
   (naturalVoiceNames.test(voice.name||"")?1:0);
  return score(right)-score(left);
 })[0]||null;
}
