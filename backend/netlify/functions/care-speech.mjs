import {sb,body,json,err,HttpError,userFromRequest} from "./_lib.mjs";

const MAX_REPLY_LENGTH=2000;
const DEFAULT_MODEL="gemini-2.5-flash-preview-tts";

function wavFromPcm(base64,mimeType){
 const pcm=Buffer.from(base64,"base64");
 const sampleRate=Number(mimeType.match(/rate=(\d+)/i)?.[1]||24000);
 const header=Buffer.alloc(44);
 header.write("RIFF",0);
 header.writeUInt32LE(36+pcm.length,4);
 header.write("WAVE",8);
 header.write("fmt ",12);
 header.writeUInt32LE(16,16);
 header.writeUInt16LE(1,20);
 header.writeUInt16LE(1,22);
 header.writeUInt32LE(sampleRate,24);
 header.writeUInt32LE(sampleRate*2,28);
 header.writeUInt16LE(2,32);
 header.writeUInt16LE(16,34);
 header.write("data",36);
 header.writeUInt32LE(pcm.length,40);
 return Buffer.concat([header,pcm]);
}

export default async req=>{
 if(req.method==="OPTIONS")return new Response("",{status:204});
 try{
  const user=await userFromRequest(req);
  const request=await body(req);
  const conversationId=typeof request?.conversationId==="string"?request.conversationId:"";
  const message=typeof request?.message==="string"?request.message.trim():"";
  if(!conversationId||!message||message.length>MAX_REPLY_LENGTH)throw new HttpError("A valid customer-care reply is required.",400);
  const apiKey=process.env.CARE_AI_API_KEY;
  if(!apiKey)throw new HttpError("Gemini speech is not configured. Use browser voice playback or contact Operations.",503);
  const db=sb();
  const {data:conversation,error:conversationError}=await db.from("support_conversations")
   .select("id")
   .eq("id",conversationId)
   .eq("customer_id",user.id)
   .maybeSingle();
  if(conversationError)throw new HttpError("Could not verify your private customer-care conversation.",503);
  if(!conversation)throw new HttpError("Customer-care conversation not found.",404);
  const {data:aiReply,error:replyError}=await db.from("support_messages")
   .select("id")
   .eq("conversation_id",conversation.id)
   .eq("sender_type","ai")
   .eq("body",message)
   .limit(1)
   .maybeSingle();
  if(replyError)throw new HttpError("Could not verify the saved AI reply.",503);
  if(!aiReply)throw new HttpError("Only a saved AI customer-care reply can be spoken.",403);

  const model=process.env.CARE_AI_TTS_MODEL||DEFAULT_MODEL;
  let response;
  try{
   response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{
    method:"POST",
    headers:{"Content-Type":"application/json","x-goog-api-key":apiKey},
    signal:AbortSignal.timeout(30000),
    body:JSON.stringify({
     contents:[{parts:[{text:message}]}],
     generationConfig:{
      responseModalities:["AUDIO"],
      speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:"Kore"}}}
     }
    })
   });
  }catch(error){
   console.error("Gemini speech generation request failed",error.message);
   throw new HttpError("Gemini voice is temporarily unavailable.",503);
  }
  if(!response.ok){
   console.error("Gemini speech generation returned an error",{status:response.status});
   throw new HttpError("Gemini voice is temporarily unavailable.",503);
  }
  const result=await response.json();
  const inlineAudio=result?.candidates?.[0]?.content?.parts?.find(part=>part.inlineData?.data)?.inlineData;
  if(typeof inlineAudio?.data!=="string"||!inlineAudio.mimeType?.toLowerCase().startsWith("audio/")){
   throw new HttpError("Gemini did not return playable speech audio.",502);
  }
  const audio=wavFromPcm(inlineAudio.data,inlineAudio.mimeType);
  return json({audioBase64:audio.toString("base64"),mimeType:"audio/wav"});
 }catch(error){
  if(!(error instanceof HttpError))console.error("Could not create spoken customer-care reply",error.message);
  return err(error);
 }
};
