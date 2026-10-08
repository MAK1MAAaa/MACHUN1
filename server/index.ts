import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { safeError } from "./manager";
import { createAppServer } from "./http";
import { AccountService } from "./accountService";
import { createDatabase, databaseUrl } from "./db/connection";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const development = process.argv.includes("--dev");
const preview = process.argv.includes("--preview");
const port = development ? 4398 : preview ? 4400 : 4399;
try {
  const connection = createDatabase(await databaseUrl(projectRoot));
  const accounts = new AccountService(connection.db, resolve(projectRoot, ".machun.local"), projectRoot);
  const server = createAppServer({
    accounts,
    distDirectory: development ? undefined : resolve(projectRoot, "dist"),
    additionalOrigins: development ? ["http://127.0.0.1:4399", "http://localhost:4399"] : [],
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(error.code === "EADDRINUSE" ? `端口 ${port} 已被占用，请先关闭其他 MACHUN1 进程。` : "本地服务无法启动。");
    void accounts.close().finally(() => connection.pool.end()).finally(() => { process.exitCode = 1; });
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`MACHUN1 ${development ? "同步 API" : "本地服务"}：http://127.0.0.1:${port}`);
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    await accounts.close();
    await connection.pool.end();
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
} catch (error) {
  console.error(safeError(error).message);
  process.exitCode = 1;
}
