/** Explicit remote administration command. Never run automatically with start/dev. */
import { readFile, readdir, rename, writeFile, chmod, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { hashPassword } from '../server/auth';

async function main() {
  const directory = fileURLToPath(new URL('../', import.meta.url));
  const envPath = join(directory, '.env');
  let original = '';
  try { original = await readFile(envPath, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const values = parseEnv(original);
  const container = values.MACHUN_MYSQL_CONTAINER ?? '1Panel-mysql-3Wrt';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(container)) throw new Error('MySQL 容器名称无效。');
  const appUser = 'machun_app';
  let appPassword = randomBytes(32).toString('hex');
  if (values.DATABASE_URL) {
    const existing = new URL(values.DATABASE_URL);
    if (existing.protocol !== 'mysql:' || existing.username !== appUser || existing.hostname !== '127.0.0.1'
      || existing.port !== '13306' || existing.pathname !== '/machun1' || !/^(?:[a-f0-9]{64}|123456)$/.test(existing.password)) {
      throw new Error('已有 DATABASE_URL 使用其他配置，请手动执行受版本管理的 SQL；本命令不会覆盖该配置。');
    }
    appPassword = existing.password;
  }
  const migrationDirectory = join(directory, 'db/migrations');
  const migration = (await Promise.all((await readdir(migrationDirectory)).filter(name => /^\d+.*\.sql$/.test(name)).sort().map(name => readFile(join(migrationDirectory, name), 'utf8')))).join('\n');
  const sql = `${migration}\nINSERT IGNORE INTO users (username,pwd) VALUES ('root','${hashPassword('pwd')}');
  CREATE USER ${values.DATABASE_URL ? 'IF NOT EXISTS ' : ''}'${appUser}'@'%' IDENTIFIED BY '${appPassword}';
  GRANT SELECT,INSERT,UPDATE,DELETE ON machun1.* TO '${appUser}'@'%';\n`;
  const shell = 'if [ -n "$MYSQL_ROOT_PASSWORD" ]; then export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; elif [ -n "$MYSQL_ROOT_PASSWORD_FILE" ]; then MYSQL_PWD="$(cat "$MYSQL_ROOT_PASSWORD_FILE")"; export MYSQL_PWD; else exit 1; fi; exec mysql --protocol=socket --user=root --default-character-set=utf8mb4';
  // No password in argv, stdout, or the SSH command. SQL travels only over encrypted stdin.
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  console.log('准备通过 ssh tencent 初始化 machun1；不会修改其他数据库。');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'tencent',
      `sudo -n docker exec -i ${container} sh -c ${quote(shell)}`], { stdio: ['pipe', 'ignore', 'pipe'] });
    child.stderr.resume(); // Database diagnostics may contain SQL with credentials.
    child.once('error', () => reject(new Error('无法启动 SSH，请检查本机 SSH 配置。')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('远程初始化失败；本地配置未更改，请检查服务器、容器和管理权限后重试。')));
    child.stdin.on('error', () => undefined);
    child.stdin.end(sql);
  });
  const url = `mysql://${appUser}:${appPassword}@127.0.0.1:13306/machun1`;
  if (!values.DATABASE_URL) {
    const temporary = `${envPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${original.trimEnd()}\n\n# MySQL via ssh tencent\nDATABASE_URL=${url}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, envPath);
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
  await chmod(envPath, 0o600);
  console.log('machun1 表结构和专用读写账号已准备；root 密码仅在用户不存在时初始化。连接配置保存在受限的 .env。下一步：pnpm db:tunnel，然后 pnpm db:catalog。');
}
main().catch(() => {
  console.error('数据库初始化未完成。请检查本地 .env、ssh tencent、MySQL 容器及管理权限；不会输出连接凭据。');
  process.exitCode = 1;
});
