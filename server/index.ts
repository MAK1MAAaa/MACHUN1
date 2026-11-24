import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configuredLoginCredentials, localEnvironment, runtimeConfig } from "./config";
import { loadLocalCatalog, openLocalDatabase } from "./db/sqlite";
import { SqliteSourceStore } from "./db/sqliteSourceStore";
import { createAppServer } from "./http";
import { SourceManager, safeError } from "./manager";
import { SyncError } from "./provider";
import { munetProvider } from "./providers/munet";
import { otogameProvider } from "./providers/otogame";
import { rinProvider } from "./providers/rin";
import { WorkspaceRepository } from "./workspace";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function start() {
  const environment = localEnvironment(projectRoot);
  const { development, port, host, dataDirectory } = runtimeConfig(environment, projectRoot, process.argv);
  const catalog = loadLocalCatalog();
  const connection = openLocalDatabase(dataDirectory);
  const workspace = new WorkspaceRepository(connection.db);
  const sources = new SourceManager({
    store: new SqliteSourceStore(connection.db, dataDirectory),
    providers: { rin: rinProvider, munet: munetProvider, otogame: otogameProvider },
    loginCredentials: configuredLoginCredentials(environment),
  });
  let initialization: Promise<SourceManager> | undefined;
  let stopping = false;
  const server = createAppServer({
    workspace,
    catalog,
    manager: () => {
      if (stopping) throw new SyncError("SHUTTING_DOWN", "服务正在关闭。", 503);
      initialization ??= sources.initialize().then(() => sources).catch(error => {
        initialization = undefined;
        throw error;
      });
      return initialization;
    },
    distDirectory: development ? undefined : resolve(projectRoot, "dist"),
    additionalOrigins: development ? ["http://127.0.0.1:4399", "http://localhost:4399"] : [],
  });

  async function stop() {
    if (stopping) return;
    stopping = true;
    const drained = new Promise<void>(resolve => server.close(() => resolve()));
    try {
      await initialization?.catch(() => undefined);
      await sources.close();
      await drained;
    } finally {
      connection.close();
    }
  }
  function shutdown() {
    void stop().catch(error => {
      console.error(safeError(error).message);
      process.exitCode = 1;
    });
  }
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(error.code === "EADDRINUSE" ? `端口 ${port} 已被占用，请先关闭其他 MACHUN1 进程。` : "本地服务无法启动。");
    process.exitCode = 1;
    shutdown();
  });
  server.listen(port, host, () => {
    console.log(`MACHUN1 ${development ? "同步 API" : "工作台"} http://${host}:${port}`);
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

try {
  start();
} catch (error) {
  console.error(safeError(error).message);
  process.exitCode = 1;
}
