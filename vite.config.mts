import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

// Frontend lives in frontend/, builds to public/ (served by the Node server).
export default defineConfig({
  root: "frontend",
  plugins: [svelte(), tailwindcss()],
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },
  server: {
    // `vite dev` HMR; proxy API calls to the running backend on 8282.
    // Override with API_PROXY_TARGET to shoot screenshots against the mock
    // backend (scripts/mock-server.mjs) instead of the live one.
    proxy: { "/api": process.env.API_PROXY_TARGET ?? "http://localhost:8282" },
  },
});
