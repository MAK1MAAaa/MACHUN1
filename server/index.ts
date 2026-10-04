import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { SourceStore } from "./store";
import { SourceManager, safeError } from "./manager";
import { createAppServer } from "./http";
import { rinProvider } from "./providers/rin";
import { munetProvider } from "./providers/munet";
import { otogameProvider } from "./providers/otogame";
import { createBrowserLauncher } from "./browser";
import { createCredentialReader } from "./credentials";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const development = process.argv.includes("--dev");
const preview = process.argv.includes("--preview");
const port = development ? 4398 : preview ? 4400 : 4399;
// The vault is outside dist and can never be served by the static-file handler.
const manager = new SourceManager({
  store: new SourceStore(resolve(projectRoot, ".machun.local")),
  providers: { rin: rinProvider, munet: munetProvider, otogame: otogameProvider },
  launcher: createBrowserLauncher(createCredentialReader(resolve(projectRoot, ".env"))),
});

try {
  await manager.initialize();
  const server = createAppServer({
    manager,
    distDirectory: development ? undefined : resolve(projectRoot, "dist"),
    additionalOrigins: development ? ["http://127.0.0.1:4399", "http://localhost:4399"] : [],
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(error.code === "EADDRINUSE" ? `端口 ${port} 已被占用，请先关闭其他 MACHUN1 进程。` : "本地服务无法启动。");
    void manager.close().finally(() => { process.exitCode = 1; });
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`MACHUN1 ${development ? "同步 API" : "本地服务"}：http://127.0.0.1:${port}`);
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    await manager.close();
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
} catch (error) {
  console.error(safeError(error).message);
  process.exitCode = 1;
}
