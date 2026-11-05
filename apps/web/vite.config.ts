import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverPort = process.env.APOLLO_PORT ?? "4317";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.APOLLO_WEB_PORT ?? 5733),
    strictPort: true,
    proxy: {
      "/rpc": { target: `ws://127.0.0.1:${serverPort}`, ws: true },
      "/api": { target: `http://127.0.0.1:${serverPort}` },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
