#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

image_archive="machun1-companion-@RELEASE@-amd64-1650.tar.gz"
project="machun1"

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' '未找到 Docker，请在已安装 Docker 的 1Panel 服务器上运行。' >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  printf '%s\n' '无法访问 Docker，请确认服务已启动并使用有 Docker 权限的账号运行。' >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' '未找到 Docker Compose 插件，请先检查 1Panel 的 Docker 安装。' >&2
  exit 1
fi

printf '%s\n' '校验部署文件……'
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c SHA256SUMS
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 -c SHA256SUMS
else
  printf '%s\n' '未找到 SHA-256 校验工具，请安装 coreutils。' >&2
  exit 1
fi

if ! docker network inspect 1panel-network >/dev/null 2>&1; then
  printf '%s\n' '未找到 1panel-network，请在现有 1Panel MySQL 所在服务器上运行。' >&2
  exit 1
fi
docker compose -p "$project" -f compose.yaml config --quiet

printf '%s\n' '导入随包镜像……'
docker load --input "$image_archive"

printf '%s\n' '启动编排并等待健康检查……'
docker compose -p "$project" -f compose.yaml up -d --no-build --pull never --wait --wait-timeout 120

container="$(docker compose -p "$project" -f compose.yaml ps -q machun1)"
if [[ -z "$container" ]]; then
  printf '%s\n' '应用容器未启动，请检查 1Panel 中的容器状态及 1650 端口占用。' >&2
  exit 1
fi
printf '%s\n' '检查现有 MySQL 连接和表结构……'
docker exec -i "$container" node --input-type=module <<'NODE'
let connection;
try {
  const mysql = await import('mysql2/promise');
  connection = await mysql.createConnection({ uri: process.env.DATABASE_URL, connectTimeout: 5000 });
  const [users] = await connection.execute('SELECT username FROM users WHERE username=?', ['root']);
  const [migrations] = await connection.execute('SELECT name FROM _machun_migrations WHERE name IN (?,?)', ['0001_accounts', '0002_source_binding_tasks']);
  if (!users.length || migrations.length !== 2) throw new Error('schema unavailable');
  console.log('MySQL 连接、root 用户及两项迁移检查通过。');
} catch {
  console.error('MySQL 连接或表结构检查失败，请检查现有数据库容器、网络和连接密码；未修改数据库。');
  process.exitCode = 1;
} finally {
  await connection?.end();
}
NODE

printf '%s\n' '部署完成：打开 http://服务器公网IP:1650，使用网页账号 root / pwd。'
