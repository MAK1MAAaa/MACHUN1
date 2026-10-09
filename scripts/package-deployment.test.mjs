import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packageDeployment } from './package-deployment.mjs';

const directories = [];
const version = 'test';
const folderName = `machun1-deploy-${version}-amd64-1650`;
const imageName = `machun1-companion-${version}-amd64-1650.tar.gz`;
const hash = value => createHash('sha256').update(value).digest('hex');
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'machun-bundle-test-')); directories.push(root);
  await mkdir(join(root, 'release')); await mkdir(join(root, 'docker'));
  const image = Buffer.from('test image payload');
  await writeFile(join(root, 'release', imageName), image);
  await writeFile(join(root, 'release', `${imageName}.sha256`), `${hash(image)}  ${imageName}\n`);
  await writeFile(join(root, 'compose.yaml'), 'services:\n  machun1:\n    image: machun1:companion-older-amd64\n    ports: ["1650:1650"]\n');
  for (const file of ['start.sh', 'DEPLOYMENT.md']) await writeFile(join(root, 'docker', file), await readFile(new URL(`../docker/${file}`, import.meta.url)));
  await writeFile(join(root, '.env'), 'PRIVATE_SECRET=must-not-ship');
  await mkdir(join(root, '.machun.local')); await writeFile(join(root, '.machun.local', 'binding.json'), 'private-portal-state');
  return root;
}
async function unpack(root) {
  const archive = await packageDeployment({ projectRoot: root, version });
  const output = join(root, 'unpacked'); await mkdir(output);
  execFileSync('tar', ['-xzf', archive, '-C', output]);
  return { archive, folder: join(output, folderName) };
}
async function runLauncher(folder, mode = 'ok') {
  const fake = join(folder, 'test-bin'); await mkdir(fake);
  const calls = join(folder, 'calls.log');
  await writeFile(join(fake, 'docker'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALLS_FILE"
if [[ "$1 $2" == "network inspect" && "$TEST_MODE" == "missing-network" ]]; then exit 1; fi
if [[ "$1" == "compose" && "$*" == *"ps -q"* ]]; then printf '%s\\n' 'test-app'; fi
if [[ "$1" == "exec" ]]; then cat > "$CALLS_FILE.sql"; if [[ "$TEST_MODE" == "mysql-failure" ]]; then exit 1; fi; fi
exit 0
`, { mode: 0o755 });
  const result = spawnSync('bash', [join(folder, 'start.sh')], { cwd: tmpdir(), encoding: 'utf8', env: {
    ...process.env, PATH: `${fake}:${process.env.PATH}`, CALLS_FILE: calls, TEST_MODE: mode,
  } });
  return { ...result, calls: await readFile(calls, 'utf8'), sql: await readFile(`${calls}.sql`, 'utf8').catch(() => '') };
}

describe('self-contained deployment package', () => {
  it('includes the verified image, matching compose, executable launcher and checksums, without private files', async () => {
    const root = await fixture(); const { archive, folder } = await unpack(root);
    expect((await readdir(folder)).sort()).toEqual(['README.md', 'SHA256SUMS', 'compose.yaml', imageName, 'start.sh'].sort());
    expect(await readFile(join(folder, 'compose.yaml'), 'utf8')).toContain('machun1:companion-test-amd64');
    expect(await readFile(join(folder, 'README.md'), 'utf8')).not.toMatch(/@[A-Z_]+@/);
    expect(await readFile(join(folder, 'start.sh'), 'utf8')).not.toContain('@RELEASE@');
    const sums = (await readFile(join(folder, 'SHA256SUMS'), 'utf8')).trim().split('\n');
    for (const line of sums) {
      const [digest, file] = line.split('  ');
      expect(hash(await readFile(join(folder, file)))).toBe(digest);
    }
    expect(await readFile(`${archive}.sha256`, 'utf8')).toBe(`${hash(await readFile(archive))}  ${folderName}.tar.gz\n`);
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    expect(entries).not.toMatch(/\.env|\.machun|\.DS_Store|\/\._/);
    expect(execFileSync('bash', ['-n', join(folder, 'start.sh')], { encoding: 'utf8' })).toBe('');
  });
  it('preserves an existing deployment archive when image validation fails', async () => {
    const root = await fixture(); const destination = join(root, 'release', `${folderName}.tar.gz`);
    await writeFile(destination, 'previous bundle'); await writeFile(join(root, 'release', imageName), 'tampered');
    await expect(packageDeployment({ projectRoot: root, version })).rejects.toThrow('镜像校验失败');
    expect(await readFile(destination, 'utf8')).toBe('previous bundle');
    expect((await readdir(join(root, 'release'))).some(name => name.startsWith('.deployment-') || name.endsWith('.partial'))).toBe(false);
  });
  it('refuses a checksum for another image archive', async () => {
    const root = await fixture(); await writeFile(join(root, 'release', `${imageName}.sha256`), `${hash('test image payload')}  another-image.tar.gz\n`);
    await expect(packageDeployment({ projectRoot: root, version })).rejects.toThrow('镜像校验失败');
  });
  it('rejects unsafe version paths before touching files', async () => {
    const root = await fixture();
    for (const value of ['../../secret', 'bad;command', 'a'.repeat(65)]) await expect(packageDeployment({ projectRoot: root, version: value })).rejects.toThrow('发布版本无效');
  });
  it('loads the bundled image and starts a stable project without pulls, builds or deleting volumes', async () => {
    const root = await fixture(); const { folder } = await unpack(root); const result = await runLauncher(folder);
    expect(result.status).toBe(0); expect(result.stdout).toContain('部署完成');
    expect(result.calls).toContain(`load --input ${imageName}`);
    expect(result.calls).toContain('compose -p machun1 -f compose.yaml up -d --no-build --pull never --wait --wait-timeout 120');
    expect(result.calls).not.toMatch(/down|rm |--remove-orphans|--renew-anon-volumes/);
    expect(result.sql).toContain('SELECT username'); expect(result.sql).not.toMatch(/ALTER|INSERT|DELETE|DROP/);
  });
  it('does not load or start containers when a deployment file checksum is invalid', async () => {
    const root = await fixture(); const { folder } = await unpack(root); await writeFile(join(folder, 'compose.yaml'), 'corrupted');
    const result = await runLauncher(folder); expect(result.status).not.toBe(0);
    expect(result.calls).not.toMatch(/load --input| up /);
  });
  it('stops before container mutations if the existing MySQL network is missing', async () => {
    const root = await fixture(); const { folder } = await unpack(root); const result = await runLauncher(folder, 'missing-network');
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('未找到 1panel-network');
    expect(result.calls).not.toMatch(/load --input| up /);
  });
  it('does not report deployment success if the database check fails', async () => {
    const root = await fixture(); const { folder } = await unpack(root); const result = await runLauncher(folder, 'mysql-failure');
    expect(result.status).not.toBe(0); expect(result.stdout).not.toContain('部署完成');
  });
});
