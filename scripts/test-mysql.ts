/** Disposable local-only MySQL 8.4 test harness. Never reads the project's .env. */
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from 'mysql2/promise';

const directory = await mkdtemp(join(tmpdir(), 'machun-mysql-test-'));
const password = randomBytes(32).toString('hex');
const name = `machun1-test-${randomBytes(6).toString('hex')}`;
const envPath = join(directory, 'mysql.env');
await writeFile(envPath, `MYSQL_ROOT_PASSWORD=${password}\nMYSQL_ROOT_HOST=%\n`, { mode: 0o600 });
let started = false;
async function command(args: string[], environment = process.env) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { env: environment, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${args[0]} 测试命令失败。`)));
  });
}
try {
  console.log('启动本机隔离 MySQL 8.4 测试容器；不访问腾讯服务器。');
  execFileSync('docker', ['run', '--detach', '--rm', '--name', name, '--publish', '127.0.0.1::3306', '--env-file', envPath,
    '--tmpfs', '/var/lib/mysql:rw,size=512m', 'mysql:8.4.11'], { stdio: ['ignore', 'pipe', 'inherit'] });
  started = true;
  const binding = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', name], { encoding: 'utf8' }))['3306/tcp'][0];
  const adminUrl = `mysql://root:${password}@127.0.0.1:${binding.HostPort}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { const connection = await createConnection(adminUrl); await connection.query('SELECT 1'); await connection.end(); ready = true; break; }
    catch { await delay(1000); }
  }
  if (!ready) throw new Error('本机测试 MySQL 启动超时。');
  // Requiring an explicit loopback URL keeps integration tests away from real credentials.
  const environment = { ...process.env, MACHUN_TEST_ADMIN_URL: adminUrl, MACHUN_TEST_CONTAINER: name };
  await command(['pnpm', 'exec', 'vitest', 'run', 'server/mysql.integration.test.ts'], environment);
  if (!process.argv.includes('--no-ui')) await command(['pnpm', 'exec', 'tsx', 'scripts/smoke-account-ui.ts'], environment);
  if (process.argv.includes('--docker')) await command(['pnpm', 'exec', 'tsx', 'scripts/smoke-docker.ts'], environment);
  if (process.argv.includes('--deployment')) await command(['pnpm', 'exec', 'tsx', 'scripts/smoke-deployment.ts'], environment);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'MySQL 测试失败。'); process.exitCode = 1;
} finally {
  if (started) try { execFileSync('docker', ['stop', '--time', '5', name], { stdio: 'ignore' }); } catch { /* already removed */ }
  await rm(directory, { recursive: true, force: true });
  console.log('隔离测试容器和临时凭证已清理。');
}
