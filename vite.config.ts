import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizePath } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { localEnvironment, runtimeConfig } from "./server/config";

const root = fileURLToPath(new URL(".", import.meta.url));
const { port: apiPort, dataDirectory } = runtimeConfig(localEnvironment(root), root, ["--dev"]);
const privateDirectories = new Set([dataDirectory]);
try {
  privateDirectories.add(realpathSync(dataDirectory));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const privateFiles = [...privateDirectories].map(directory =>
  `${normalizePath(directory).replace(/[[\]{}()*?!+@]/g, "\\$&")}/**`);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4399,
    strictPort: true,
    cors: false,
    fs: {
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.machun.local/**", ...privateFiles],
    },
    proxy: {
      "/api": { target: `http://127.0.0.1:${apiPort}` },
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
