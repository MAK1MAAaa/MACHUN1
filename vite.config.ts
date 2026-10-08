import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4399,
    strictPort: true,
    fs: {
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.machun.local/**"],
    },
    proxy: {
      "/api": { target: "http://127.0.0.1:4398", changeOrigin: true },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4400,
    strictPort: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "server/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
