# 本地运行

网页、Node 服务和 MySQL 均在自己的电脑上运行。已验收环境为 macOS，使用 Node.js 24.x、pnpm 10.15.0 和 MySQL 8.4。

## 1. 安装项目依赖

先安装 Node.js 24.x 和 MySQL 8.4，并启动本机 MySQL 服务。在终端执行：

```bash
corepack enable
corepack prepare pnpm@10.15.0 --activate
git clone https://github.com/MAK1MAAaa/MACHUN1.git
cd MACHUN1
pnpm install --frozen-lockfile
pnpm browser:install
```

已有项目时，在当前项目目录安装依赖即可。后续命令均在项目根目录执行。

## 2. 初始化本机数据库

使用 MySQL 管理员连接本机数据库，按提示输入数据库管理员密码：

```bash
mysql --host=127.0.0.1 --port=3306 --user=root --password --default-character-set=utf8mb4
```

在 MySQL 命令行依次执行以下 SQL。将 `replace_with_your_local_password` 替换成自己设置的数据库应用账号密码，并在下一步使用相同密码。

```sql
SOURCE db/migrations/0001_accounts.sql;
SOURCE db/migrations/0002_source_binding_tasks.sql;
SOURCE db/migrations/0003_score_clear_status.sql;
SOURCE db/migrations/0004_export_nickname.sql;

INSERT IGNORE INTO machun1.users (username, pwd)
VALUES ('root', LOWER(SHA2('pwd', 256)));

CREATE USER IF NOT EXISTS 'machun_app'@'%'
IDENTIFIED BY 'replace_with_your_local_password';
GRANT SELECT, INSERT, UPDATE, DELETE ON machun1.* TO 'machun_app'@'%';

EXIT;
```

`root / pwd` 是初始网页登录账号；上面的 MySQL 管理员和 `machun_app` 是数据库账号。应用只使用 `machun_app` 的读写权限。重复执行迁移和 `INSERT IGNORE` 不会重置已有网页密码；数据库应用账号已存在时，继续使用其原密码。

## 3. 配置本地连接

在项目根目录创建 `.env`；已有文件时先备份，再修改对应配置：

```dotenv
DATABASE_URL=mysql://machun_app:replace_with_your_local_password@127.0.0.1:3306/machun1
MACHUN_LISTEN_HOST=127.0.0.1
```

数据库密码包含 `@`、`:`、`/`、`#`、`%` 等 URL 特殊字符时，需要在连接地址中进行百分号编码。MySQL 使用其他端口时，同时修改管理连接和 `DATABASE_URL` 的端口。

本机弹窗登录使用默认绑定模式；如果已有 `.env` 中设置了 `MACHUN_BINDING_MODE=companion`，移除该项。纯本地运行也应移除此前部署使用的 `MACHUN_PUBLIC_ORIGIN` 和 `MACHUN_PORT`，以采用默认的本机地址与端口。

```bash
chmod 600 .env
pnpm db:catalog
pnpm start
```

打开 [http://127.0.0.1:4399/](http://127.0.0.1:4399/)，首次使用 `root / pwd` 登录。曲库入库后会显示 1,522 张评分谱面和 384 张详情补充。已有本地库的个人成绩和绑定继续保留。

这条流程直接连接本机 MySQL。`pnpm db:setup` 和 `pnpm db:tunnel` 用于现有的远程 SSH 方案，本地初始化按上面的 SQL 完成。

## 4. 开发、绑定和停止

日常使用执行 `pnpm start`。开发时执行：

```bash
pnpm dev
```

开发网页为 `http://127.0.0.1:4399/`，API 为 `127.0.0.1:4398`，网页通过 Vite 代理访问 API。保留默认端口时，无需设置 `MACHUN_PORT`；如果已有配置设置了该项，开发前移除以使用默认的 API 端口。

登录网页后展开「成绩来源」，点击对应来源的绑定按钮，在本机弹出的独立浏览器中手动登录并完成验证码。落雪填写个人 API Token。已保存的会话可用于后续同步，无需运行登录助手。

停止网页服务或开发服务时，在启动终端按 **Ctrl+C**。MySQL 中的成绩和 `.machun.local/` 中的本地登录状态继续保留。数据库服务可通过自己的 MySQL 管理方式单独停止。

检查项目：

```bash
pnpm test
pnpm build
```

`pnpm test:mysql` 使用独立 Docker MySQL 测试库，需要本机 Docker 和 Google Chrome；不会读取这份 `.env` 或连接自己的数据库。

## 常见问题

- **无法连接数据库**：确认 MySQL 正在运行，端口和 `DATABASE_URL` 一致，应用账号密码正确，四项迁移均已执行。当前运行连接也可能被终端中的 `DATABASE_URL` 环境变量覆盖。
- **服务启动但登录失败**：确认已在当前连接的 `machun1` 库执行默认用户插入 SQL；已有用户保留原网页密码。
- **端口被占用**：先停止旧的 `pnpm start` / `pnpm dev`；日常运行也可修改 `MACHUN_PORT` 并使用对应地址访问。
- **绑定未弹出窗口**：确认已运行 `pnpm browser:install`，使用本机桌面环境，且未设置 `MACHUN_BINDING_MODE=companion`。
- **切换数据库后看不到原成绩**：不同 MySQL 数据库分别保存工作区。可在旧环境导出完整备份，再在新环境登录后导入。
