import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

test("App receives the profile setter used by rider approval refreshes", () => {
  assert.match(app, /return \{session,profile,setProfile,loading,profileLoading,profileError\}/);
  assert.match(app, /const \{session,profile,setProfile,loading,profileLoading,profileError\}=useSession\(\)/);
});
