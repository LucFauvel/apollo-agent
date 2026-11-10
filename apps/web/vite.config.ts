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
  worker: {
    plugins: () => [
      {
        // Workers have no DOM: the markdown parser's entity decoder has a DOM build for
        // browsers (index.dom.js, document.createElement) and a plain one, used here
        // (the search index renders markdown in src/searchWorker.ts).
        name: "worker-without-dom",
        enforce: "pre",
        async resolveId(source, importer, options) {
          if (source !== "decode-named-character-reference") return null;
          const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
          return resolved ? { ...resolved, id: resolved.id.replace(/index\.dom\.js$/, "index.js") } : null;
        },
      },
    ],
  },
});
