import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import {fileURLToPath} from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve:{alias:{"@niivue-slice-source":fileURLToPath(new URL("./node_modules/@niivue/niivue/src/shader-srcs.ts",import.meta.url))}},
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET || "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
