import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGzip } from 'node:zlib';

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Whitelist only the public deployment files; never copy the project directory. */
export async function packageDeployment({ projectRoot = fileURLToPath(new URL('../', import.meta.url)), imageSource = 'archive', version = process.env.MACHUN_RELEASE ?? (imageSource === 'hub' ? '20261009' : '20261009-ip') } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,63}$/.test(version)) throw new Error('发布版本无效。');
  if (!['archive', 'hub'].includes(imageSource)) throw new Error('镜像来源无效。');
  const release = resolve(projectRoot, 'release');
  await mkdir(release, { recursive: true });
  const imageName = `machun1-companion-${version}-amd64-1650.tar.gz`;
  const imagePath = resolve(release, imageName);
  let imageHash;
  if (imageSource === 'archive') {
    const checksum = (await readFile(`${imagePath}.sha256`, 'utf8')).trim();
    const expected = /^([a-f0-9]{64}) {2}([^\r\n]+)$/.exec(checksum);
    if (!expected || expected[2] !== imageName || await hashFile(imagePath) !== expected[1]) throw new Error('镜像校验失败，请重新导出镜像。');
    imageHash = expected[1];
  }

  const compose = await readFile(resolve(projectRoot, imageSource === 'hub' ? 'compose.hub.yaml' : 'compose.yaml'), 'utf8');
  const imageLine = imageSource === 'hub'
    ? /^(\s*image:\s*)mak1maaaa\/machun1:[a-zA-Z0-9._-]+\s*$/m
    : /^(\s*image:\s*)machun1:companion-[a-zA-Z0-9.-]+-amd64\s*$/m;
  if (!imageLine.test(compose)) throw new Error('compose.yaml 中的项目镜像配置无效。');
  const bundledCompose = imageSource === 'hub' ? compose : compose.replace(imageLine, `$1machun1:companion-${version}-amd64`);
  const folderName = `machun1-${imageSource === 'hub' ? 'hub-' : ''}deploy-${version}-amd64-1650`;
  const filename = `${folderName}.tar.gz`;
  const destination = resolve(release, filename);
  const partial = `${destination}.partial`;
  const staging = await mkdtemp(resolve(release, '.deployment-'));
  try {
    const folder = resolve(staging, folderName);
    await mkdir(folder, { mode: 0o700 });
    if (imageSource === 'archive') await copyFile(imagePath, resolve(folder, imageName), constants.COPYFILE_FICLONE);
    await writeFile(resolve(folder, 'compose.yaml'), bundledCompose, { mode: 0o600 });
    const launcher = (await readFile(resolve(projectRoot, 'docker/start.sh'), 'utf8')).replaceAll('@RELEASE@', version).replaceAll('@IMAGE_SOURCE@', imageSource);
    await writeFile(resolve(folder, 'start.sh'), launcher, { mode: 0o755 });
    await chmod(resolve(folder, 'start.sh'), 0o755);
    const instructions = (await readFile(resolve(projectRoot, imageSource === 'hub' ? 'docker/HUB-DEPLOYMENT.md' : 'docker/DEPLOYMENT.md'), 'utf8'))
      .replaceAll('@PACKAGE_FILENAME@', filename)
      .replaceAll('@PACKAGE_DIRECTORY@', folderName)
      .replaceAll('@IMAGE_FILENAME@', imageName);
    await writeFile(resolve(folder, 'README.md'), instructions);
    const files = [...(imageSource === 'archive' ? [imageName] : []), 'compose.yaml', 'start.sh', 'README.md'];
    const digests = [];
    for (const file of files) digests.push(`${await hashFile(resolve(folder, file))}  ${file}\n`);
    if (imageHash && !digests[0].startsWith(imageHash)) throw new Error('镜像打包期间发生变化。');
    await writeFile(resolve(folder, 'SHA256SUMS'), digests.join(''));

    // The image is already compressed; a light outer gzip avoids rebuilding it.
    const tar = spawn('tar', ['-cf', '-', '-C', staging, folderName], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
    tar.stderr.resume();
    const completed = new Promise((resolve, reject) => {
      tar.once('error', reject);
      tar.once('exit', code => code === 0 ? resolve() : reject(new Error('部署文件归档失败。')));
    });
    try { await Promise.all([pipeline(tar.stdout, createGzip({ level: 1 }), createWriteStream(partial, { mode: 0o600 })), completed]); }
    catch (error) { tar.kill('SIGTERM'); await completed.catch(() => undefined); throw error; }
    await rename(partial, destination);
    await writeFile(`${destination}.sha256`, `${await hashFile(destination)}  ${filename}\n`, { mode: 0o600 });
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(partial, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  packageDeployment({ imageSource: process.argv.includes('--hub') ? 'hub' : 'archive' }).then(path => console.log(`已生成部署包：${path}`)).catch(() => {
    console.error('部署包生成失败，请检查镜像归档、校验文件与编排；已有归档保留。');
    process.exitCode = 1;
  });
}
