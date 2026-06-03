import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// For local dev with `vercel dev`, the /api function is served on the same
// origin, so no proxy is needed. If you run `vite` alone AND a separate
// backend on :3000, uncomment the proxy block below.
export default defineConfig({
  plugins: [react()],
  // server: { proxy: { "/api": "http://localhost:3000" } },
});
