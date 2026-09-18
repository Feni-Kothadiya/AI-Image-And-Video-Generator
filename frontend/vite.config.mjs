import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4000",
      "/media": "http://127.0.0.1:4000",
      "/seed-assets": "http://127.0.0.1:4000",
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4000",
      "/media": "http://127.0.0.1:4000",
      "/seed-assets": "http://127.0.0.1:4000",
    },
  },
});
