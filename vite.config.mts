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
    proxy: { "/api": "http://localhost:8282" },
  },
});
