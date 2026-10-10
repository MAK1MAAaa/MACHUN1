/** Exercise the packaged launcher against disposable MySQL and an isolated project. */
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareTestDatabase } from './mysql-test-fixture';

const fixture = await prepareTestDatabase();
const directory = await mkdtemp(join(tmpdir(), 'machun-deployment-smoke-'));
const project = `machun1-test-deploy-${randomBytes(6).toString('hex')}`;
const network = `${project}-network`;
const mysqlContainer = process.env.MACHUN_TEST_CONTAINER!;
const hub = process.argv.includes('--hub');
const bundleName = hub ? 'machun1-hub-deploy-20261009-amd64-1650' : 'machun1-deploy-20261009-ip-amd64-1650';
const archive = resolve(`release/${bundleName}.tar.gz`);
let folder: string | undefined;
let networkCreated = false;
let connected = false;
let launchAttempted = false;
async function digest(path: string) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex');
}
function docker(args: string[]) { return execFileSync('docker', args, { encoding: 'utf8' }).trim(); }
try {
  const checksum = (await readFile(`${archive}.sha256`, 'utf8')).split('  ')[0];
  assert.equal(await digest(archive), checksum);
  execFileSync('tar', ['-xzf', archive, '-C', directory]);
  const [name] = await readdir(directory); assert.equal(name, bundleName); folder = join(directory, name);
  execFileSync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: folder, stdio: 'inherit' });
  await fixture.admin.query("CREATE USER IF NOT EXISTS 'machun_app'@'%' IDENTIFIED BY '123456'; ALTER USER 'machun_app'@'%' IDENTIFIED BY '123456'; GRANT SELECT,INSERT,UPDATE,DELETE ON machun1.* TO 'machun_app'@'%';");
  docker(['network', 'create', network]); networkCreated = true;
  docker(['network', 'connect', '--alias', '1Panel-mysql-3Wrt', network, mysqlContainer]); connected = true;

  // Only adapt the copy's project/network/host port; never use production names.
  const composePath = join(folder, 'compose.yaml');
  const compose = (await readFile(composePath, 'utf8')).replaceAll('1panel-network', network).replace('"1650:1650"', '"127.0.0.1:0:1650"');
  await writeFile(composePath, compose);
  const launcherPath = join(folder, 'start.sh');
  await writeFile(launcherPath, (await readFile(launcherPath, 'utf8')).replace('project="machun1"', `project="${project}"`).replaceAll('1panel-network', network));
  const files = (await readFile(join(folder, 'SHA256SUMS'), 'utf8')).trim().split('\n').map(line => line.split('  ')[1]);
  const sums: string[] = []; for (const file of files) sums.push(`${await digest(join(folder, file))}  ${file}\n`);
  await writeFile(join(folder, 'SHA256SUMS'), sums.join(''));
  launchAttempted = true;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('bash', [launcherPath], { cwd: tmpdir(), stdio: 'inherit' });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('部署脚本检查未通过。')));
  });
  const container = docker(['compose', '-p', project, '-f', composePath, 'ps', '-q', 'machun1']); assert(container);
  if (hub) {
    const image = docker(['inspect', '--format', '{{.Config.Image}}', container]);
    assert.equal(image, 'mak1maaaa/machun1:latest');
    const imageEnvironment: string[] = JSON.parse(docker(['image', 'inspect', '--platform', 'linux/amd64', '--format', '{{json .Config.Env}}', image]));
    assert(!imageEnvironment.some(value => value.startsWith('DATABASE_URL=') || value.includes('123456')));
    const environment: string[] = JSON.parse(docker(['inspect', '--format', '{{json .Config.Env}}', container]));
    assert(environment.includes('DATABASE_URL=mysql://machun_app:123456@1Panel-mysql-3Wrt:3306/machun1'));
  }
  const port = JSON.parse(docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', container]))['1650/tcp'][0].HostPort;
  const login = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const input = '{"username":"root","password":"pwd"}';
    const request = httpRequest({ hostname: '127.0.0.1', port, path: '/api/auth/login', method: 'POST', headers: {
      Host: '203.0.113.12:1650', Origin: 'http://203.0.113.12:1650', 'X-Machun-Request': '1', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(input),
    } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => body += chunk); response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(body) }));
    });
    request.on('error', reject); request.end(input);
  });
  assert.equal(login.status, 200); assert.deepEqual(login.body, { user: { username: 'root' } });
  console.log(`PASS ${hub ? 'Hub 部署包校验、镜像拉取、编排自动注入连接、公开镜像无数据库密码' : '一体部署包校验、解压、镜像导入'}、Compose 启动、健康等待、真实 MySQL 只读检查和 root 登录；使用独立测试项目及本机随机端口。`);
} finally {
  if (launchAttempted && folder) try { docker(['compose', '-p', project, '-f', join(folder, 'compose.yaml'), 'down', '--volumes']); } catch { /* clean remaining test resources below */ }
  if (connected) try { docker(['network', 'disconnect', network, mysqlContainer]); } catch { /* disconnected */ }
  if (networkCreated) try { docker(['network', 'rm', network]); } catch { /* removed by compose */ }
  await fixture.pool.end(); await fixture.admin.end(); await rm(directory, { recursive: true, force: true });
}
