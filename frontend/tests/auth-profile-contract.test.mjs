import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

test("App receives the profile setter used by rider approval refreshes", () => {
  assert.match(app, /return \{session,profile,setProfile,loading,profileLoading,profileError\}/);
  assert.match(app, /const \{session,profile,setProfile,loading,profileLoading,profileError\}=useSession\(\)/);
});

test("profile refreshes do not clear role state on access-token renewal", () => {
  assert.match(app, /currentUserId\.current!==nextUserId/);
  assert.match(app, /event==="SIGNED_IN"\|\|event==="USER_UPDATED"/);
  assert.match(app, /from\("profiles"\)\.select\("\*"\)\.eq\("id",session\.user\.id\)/);
  assert.match(app, /table:"profiles",filter:`id=eq\.\$\{session\.user\.id\}`/);
  assert.match(app, /setProfileRevision\(value=>value\+1\)/);
});

test("logout waits for Supabase, reports failure, and routes to a neutral signed-out screen", () => {
  assert.match(app, /const \{error\}=await supabase\.auth\.signOut\(\);/);
  assert.match(app, /if\(error\)throw error/);
  assert.match(app, /Could not sign out\. Your session is still active/);
  assert.match(app, /go\("\/login"\)/);
  assert.match(app, /function LoginLanding\(/);
  assert.match(app, /<Customer key=\{`\$\{session\?\.user\?\.id\|\|"guest"\}:\$\{profile\?\.role\|\|"unresolved"\}`\}/);
  assert.match(app, /<Rider key=\{`\$\{session\?\.user\?\.id\|\|"guest"\}:\$\{profile\?\.role\|\|"unresolved"\}`\}/);
});

test("customer wallet failures do not leave an old balance presented as current", () => {
  assert.match(app, /if\(walletResult\.error\)\{setWalletBalance\(0\);setWalletError\(/);
  assert.match(app, /setWalletError\(""\);setWalletBalance\(Number\(walletResult\.data\|\|0\)\)/);
  assert.match(app, /walletError\?"Balance unavailable":money\(walletBalance\)/);
});
