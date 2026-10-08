import { resolve } from "node:path";

export function runtimeConfig(environment: NodeJS.ProcessEnv, projectRoot: string, args: string[] = []) {
  const development = args.includes("--dev");
  const port = Number(environment.MACHUN_PORT ?? (development ? 4398 : args.includes("--preview") ? 4400 : 4399));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MACHUN_PORT 必须是有效端口。");
  const host = environment.MACHUN_LISTEN_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "0.0.0.0"].includes(host)) throw new Error("MACHUN_LISTEN_HOST 仅支持 127.0.0.1 或 0.0.0.0。");
  const rawOrigin = environment.MACHUN_PUBLIC_ORIGIN;
  let publicOrigin: string | undefined;
  if (rawOrigin) {
    let url: URL;
    try { url = new URL(rawOrigin); } catch { throw new Error("MACHUN_PUBLIC_ORIGIN 必须是完整的 HTTP(S) 访问地址。"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("MACHUN_PUBLIC_ORIGIN 必须是完整的 HTTP(S) 访问地址，不含子路径。");
    }
    publicOrigin = url.origin;
  }
  const accessPassword = environment.MACHUN_ACCESS_PASSWORD || undefined;
  if (host === "0.0.0.0" && (!publicOrigin || !accessPassword || accessPassword.length < 12)) {
    throw new Error("部署模式必须配置 MACHUN_PUBLIC_ORIGIN 和至少 12 位的 MACHUN_ACCESS_PASSWORD。");
  }
  return {
    development, port, host, publicOrigin, accessPassword,
    dataDirectory: resolve(environment.MACHUN_DATA_DIR ?? resolve(projectRoot, ".machun.local")),
    remoteDesktop: environment.MACHUN_REMOTE_LOGIN === "1",
  };
}
