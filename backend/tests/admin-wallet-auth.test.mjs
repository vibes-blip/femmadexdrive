import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {userWithProfileRole} from "../netlify/functions/_lib.mjs";

const server=readFileSync(new URL("../server.mjs",import.meta.url),"utf8");
const handler=readFileSync(new URL("../netlify/functions/admin-wallet.mjs",import.meta.url),"utf8");
const component=readFileSync(new URL("../../frontend/src/AdminWalletPayouts.jsx",import.meta.url),"utf8");

function request(token){
 return new Request("https://femmadexdrive.example/api/admin-wallet",{
  method:"POST",
  headers:token?{Authorization:`Bearer ${token}`}:{},
  body:JSON.stringify({action:"list"})
 });
}

function dbFor({authResult,profileResult}){
 const lookups=[];
 const query={
  select(){return this},
  eq(column,value){lookups.push([column,value]);return this},
  async maybeSingle(){return profileResult}
 };
 return {
  lookups,
  from(table){assert.equal(table,"profiles");return query},
  auth:{async getUser(token){assert.equal(token,"test-access-token");return authResult}}
 };
}

test("Render maps POST /api/admin-wallet to the protected wallet handler",()=>{
 assert.match(server,/\["admin-wallet",\s*\{\s*method:\s*"POST",\s*load:\s*\(\)\s*=>\s*import\("\.\/netlify\/functions\/admin-wallet\.mjs"\)\s*\}\]/);
 assert.match(handler,/userWithProfileRole\(req,\["admin"\],db\)/);
});

test("an authenticated admin is authorized using the authenticated UUID's trusted profile",async()=>{
 const db=dbFor({
  authResult:{data:{user:{id:"admin-user"}},error:null},
  profileResult:{data:{role:"admin"},error:null}
 });
 const user=await userWithProfileRole(request("test-access-token"),["admin"],db);
 assert.equal(user.id,"admin-user");
 assert.deepEqual(db.lookups,[["id","admin-user"]]);
});

test("missing access tokens are rejected with 401 before profile access",async()=>{
 let authCalls=0;
 const db=dbFor({authResult:null,profileResult:{data:{role:"admin"},error:null}});
 db.auth.getUser=async()=>{authCalls++;return {data:{user:null},error:null}};
 await assert.rejects(userWithProfileRole(request(null),["admin"],db),error=>error.status===401);
 assert.equal(authCalls,0);
 assert.deepEqual(db.lookups,[]);
});

for(const message of ["Invalid JWT","JWT expired"]){
 test(`invalid or expired access tokens are rejected with 401 (${message})`,async()=>{
  const db=dbFor({
   authResult:{data:{user:null},error:{status:401,message}},
   profileResult:{data:{role:"admin"},error:null}
  });
  await assert.rejects(userWithProfileRole(request("test-access-token"),["admin"],db),error=>error.status===401);
  assert.deepEqual(db.lookups,[]);
 });
}

for(const role of ["customer","rider"]){
 test(`${role} account is authenticated but forbidden from administrator wallet data`,async()=>{
  const db=dbFor({
   authResult:{data:{user:{id:`${role}-user`}},error:null},
   profileResult:{data:{role},error:null}
  });
  await assert.rejects(userWithProfileRole(request("test-access-token"),["admin"],db),error=>error.status===403);
  assert.deepEqual(db.lookups,[["id",`${role}-user`]]);
 });
}

test("wallet UI sends its current session token and clears stale financial data on request failure",()=>{
 assert.match(component,/Authorization:/);
 assert.match(component,/access_token/);
 assert.match(component,/authClient\.auth\.getSession\(\)/);
 assert.match(component,/currentSession\.user\.id!==initialSession\?\.user\?\.id/);
 assert.match(component,/request\("list",session,\{\},supabase\)/);
 assert.match(component,/request\("finalize",session,\{withdrawalId,otp:otpById\[withdrawalId\]\|\|""\},supabase\)/);
 assert.match(component,/if\(!response\.ok\)throw Object\.assign\(new Error\(result\.error\|\|"Admin wallet request failed\."\),\{status:response\.status\}\)/);
 assert.match(component,/setWithdrawals\(\[\]\)/);
 assert.match(component,/session is invalid or expired/i);
 assert.match(readFileSync(new URL("../../frontend/src/App.jsx",import.meta.url),"utf8"),/<AdminWalletPayouts session=\{session\} supabase=\{supabase\} toast=\{toast\}\/>/);
});
