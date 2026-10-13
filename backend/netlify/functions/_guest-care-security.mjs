import crypto from "node:crypto";

const TOKEN_LIFETIME_MS=12*60*60*1000;

const signature=(value,secret)=>crypto.createHmac("sha256",secret).update(value).digest("base64url");

export function createGuestCareToken(sessionId,secret,now=Date.now()){
 if(!secret)throw new Error("Guest care session signing is not configured.");
 const expiresAt=now+TOKEN_LIFETIME_MS;
 const payload=`v1.${sessionId}.${expiresAt}`;
 return {token:`${payload}.${signature(payload,secret)}`,expiresAt};
}

export function verifyGuestCareToken(token,secret,now=Date.now()){
 if(!secret||typeof token!=="string")return null;
 const parts=token.split(".");
 if(parts.length!==4||parts[0]!=="v1") return null;
 const [,sessionId,expiresAtText,suppliedSignature]=parts;
 if(!/^[0-9a-f-]{36}$/i.test(sessionId)||!/^\d+$/.test(expiresAtText))return null;
 const expiresAt=Number(expiresAtText);
 if(!Number.isSafeInteger(expiresAt)||expiresAt<=now||expiresAt>now+TOKEN_LIFETIME_MS)return null;
 const payload=`v1.${sessionId}.${expiresAt}`;
 const expected=signature(payload,secret);
 const supplied=Buffer.from(suppliedSignature);
 const expectedBuffer=Buffer.from(expected);
 if(supplied.length!==expectedBuffer.length||!crypto.timingSafeEqual(supplied,expectedBuffer))return null;
 return {sessionId,expiresAt};
}

export function guestCareRateLimitHash(value,secret){
 if(!secret)throw new Error("Guest care rate limiting is not configured.");
 return crypto.createHmac("sha256",secret).update(String(value||"unknown")).digest("hex");
}

export function guestCareClientAddress(request){
 const forwarded=request.headers.get("x-nf-client-connection-ip");
 if(forwarded)return forwarded.trim().slice(0,128)||"unknown";
 const serverAddress=request.headers.get("x-fdd-client-address");
 if(serverAddress)return serverAddress.trim().slice(0,128)||"unknown";
 return "unknown";
}
