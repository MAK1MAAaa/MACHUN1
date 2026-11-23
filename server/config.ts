import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { SyncError } from "./provider";

export function localEnvironment(projectRoot: string): NodeJS.ProcessEnv {
  try {
    return { ...parseEnv(readFileSync(resolve(projectRoot, ".env"), "utf8")), ...process.env };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { ...process.env };
  }
}

export function runtimeConfig(environment: NodeJS.ProcessEnv, projectRoot: string, args: string[] = []) {
  const development = args.includes("--dev");
  const port = development ? 4398 : Number(environment.MACHUN_PORT ?? (args.includes("--preview") ? 4400 : 4399));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SyncError("INVALID_CONFIG", "MACHUN_PORT 必须是有效端口。");

  const dataDirectory = resolve(projectRoot, environment.MACHUN_DATA_DIR || ".machun.local");
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
  };
  if (contains(dataDirectory, projectRoot) || ["dist", "public"].some(folder => contains(resolve(projectRoot, folder), dataDirectory))) {
    throw new SyncError("INVALID_CONFIG", "MACHUN_DATA_DIR 必须指向单独的数据目录，不能使用项目目录或静态文件目录。");
  }

  return { development, port, host: "127.0.0.1", dataDirectory } as const;
}
