import process from "node:process";
import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
 plugins:[react()],
 server:{
  proxy:{
   "/api":{
    target:process.env.API_PROXY_TARGET||"http://127.0.0.1:10000",
    changeOrigin:true
   }
  }
 }
});