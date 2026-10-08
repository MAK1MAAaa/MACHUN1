import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = process.env.MACHUN_RELEASE ?? "20261009-ip";
if (!/^[a-zA-Z0-9.-]+$/.test(version)) throw new Error("发布版本无效");
const tag = `machun1:companion-${version}-amd64`;
const filename = `machun1-companion-${version}-amd64-1650.tar.gz`;
const destination = resolve(root, "release", filename);
const temporary = `${destination}.partial`;
function completed(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Docker 命令失败 (${code ?? signal})`)));
  });
}
try {
  await mkdir(resolve(root, "release"), { recursive: true });
  if (!process.argv.includes("--save-only")) {
    const build = spawn("docker", ["buildx", "build", "--platform", "linux/amd64", "--load", "--tag", tag, "."], { cwd: root, stdio: "inherit" });
    await completed(build);
  }
  const save = spawn("docker", ["image", "save", tag], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  const saved = completed(save);
  try { await Promise.all([pipeline(save.stdout, createGzip({ level: 6 }), createWriteStream(temporary)), saved]); }
  catch (error) { save.kill("SIGTERM"); await saved.catch(() => undefined); throw error; }
  await rename(temporary, destination);
  const checksum = createHash("sha256");
  for await (const chunk of createReadStream(destination)) checksum.update(chunk);
  await writeFile(`${destination}.sha256`, `${checksum.digest("hex")}  ${filename}\n`);
  console.log(`已导出可供 1Panel 导入的 amd64 Docker 镜像：${destination}`);
} catch (error) {
  await rm(temporary, { force: true });
  console.error(error instanceof Error ? error.message : "镜像打包失败");
  process.exitCode = 1;
}
