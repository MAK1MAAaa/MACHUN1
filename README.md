<div align="center">

# MACHUN1

**CHUNITHM 成绩管理 · 四源同步 · B30 导出**

将不同服务器的成绩合并为综合最高分，在电脑与手机上管理自己的 Rating 工作区。

![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square)
![MySQL](https://img.shields.io/badge/MySQL-8.4-4479A1?style=flat-square)
![Docker](https://img.shields.io/badge/Docker-linux%2Famd64-2496ED?style=flat-square)
[![License](https://img.shields.io/badge/License-Apache%202.0-6B7280?style=flat-square)](LICENSE)

[快速开始](#quick-start) · [绑定与同步](#sync) · [成绩与导出](#records) · [开发](#development) · [常见问题](#faq)

[Docker Hub](https://hub.docker.com/r/mak1maaaa/machun1) · [1Panel 部署说明](docs/1panel.md) · [曲库来源](src/data/catalog-sources.json)

</div>

---

## 能做什么

| 成绩管理 | 曲库与浏览 | 数据与部署 |
| --- | --- | --- |
| MuNET、Rin、大饼、国服落雪分别同步 | Rating 排名、曲库筛选，每页 10 项 | MySQL 保存成绩，按用户隔离 |
| 合并最高分，支持手动改分与文件导入 | 搜索曲名、别名和 ID，查看歌曲详情 | 电脑与手机登录同一账号读取数据 |
| 保留 FC / AJ / AJC、FULL CHAIN 与评级 | 筛选难度、等级、定数、分类、版本及来源 | Docker / 1Panel 部署，无远程桌面 |
| B30、候选20、PNG 与 JSON 导出 | 查看未游玩谱面，按分数排序 | 完整成绩与个人别名备份 |

**当前曲库**：截至 **2026-10-08** 的日服 Mate 快照，包含 **1,507 张 13.0+ 谱面、1,243 首歌曲**，支持 EXP、MAS、ULT；内置 **2,458 条别名，覆盖 800 首歌曲**。详情卡另有低定数补充，未知定数显示 `/`。

应用采用 React、TypeScript、Vite、Node.js、mysql2 和 Drizzle。网页只提供登录，暂不提供注册；成绩同步由用户主动触发。

<a id="quick-start"></a>

## 快速开始

### Docker / 1Panel

适合部署到服务器后，通过 `http://服务器公网IP:1650` 使用。镜像为 `linux/amd64`，支持 `latest` 和固定标签 `20261009-amd64`。

| 方式 | 操作 |
| --- | --- |
| 从 Docker Hub 拉取 | 在 1Panel「容器 → 编排」使用 [compose.hub.yaml](compose.hub.yaml)，项目名设为 `machun1`。 |
| 上传部署包 | 上传并解压本地生成的 `release/machun1-hub-deploy-20261009-amd64-1650.tar.gz`，进入目录运行 `sudo bash start.sh`。 |
| 离线部署 | 使用 `pnpm docker:package` 生成的一体部署包；启动脚本导入随包镜像后启动编排。 |

也可以在服务器终端执行：

```bash
docker compose -p machun1 -f compose.hub.yaml pull
docker compose -p machun1 -f compose.hub.yaml up -d
```

**编排面向已有 1Panel MySQL 环境**：默认接入 `1panel-network`，映射 `1650:1650`，将 `/data` 保存到命名卷。它不会自动创建数据库或执行迁移；换用其他数据库时需要调整连接并初始化表结构。仅拉取镜像再单独创建容器，不会获得编排中的数据库配置。

首次初始化的网页账号为 `root / pwd`，重复迁移不会重置已有密码。端口、数据库准备、更新和备份见 [1Panel 部署说明](docs/1panel.md)。部署包由本地打包命令生成，不随 Git 仓库提供。

### 本机运行

已验收的桌面环境为 macOS。建议 Node.js **24.x**，项目指定 pnpm **10.15.0**，数据库使用 MySQL **8.4**。

```bash
git clone https://github.com/MAK1MAAaa/MACHUN1.git
cd MACHUN1
pnpm install
pnpm browser:install
```

将数据库连接放入被 Git 忽略的 `.env`。已有远程数据库时，需要本机 SSH 配置中存在 `tencent` 别名：

```bash
# 保持该终端运行；将本机 13306 转发到服务器 MySQL 的 3306
pnpm db:tunnel

# 在另一个终端更新共享曲库并启动应用
pnpm db:catalog
pnpm start
```

打开 [http://127.0.0.1:4399/](http://127.0.0.1:4399/)。首次建库可显式执行 `pnpm db:setup`，它通过 SSH 管理连接执行 [迁移 SQL](db/migrations/)，创建仅有 CRUD 权限的应用账号；不要把数据库管理账号用于应用运行。自定义数据库参考 [.env.example](.env.example)，管理连接需完成全部迁移。

停止时，在网页服务和 SSH 隧道各自的终端按 **Ctrl+C**。成绩和已保存的绑定不会随进程关闭而删除。

<a id="sync"></a>

## 绑定与同步

登录后展开「成绩来源」，绑定账号，再点击对应来源的「同步成绩」。每个网页账号的成绩、个人别名、绑定、Token 和同步缓存独立保存。

| 来源 | 绑定方式 | 同步行为 |
| --- | --- | --- |
| [MuNET](https://portal.mumur.net/user) | 门户账号登录，手动完成滑块或验证码 | 获取 CHUNITHM 存档；无法续期时重新登录 |
| [Rin](https://portal.naominet.live/) | 门户登录，绑定选中的 Aime 卡 | 核对卡片归属后同步，不修改门户默认卡 |
| [大饼](https://u.otogame.net/) | 门户登录，绑定当前主卡 | 首次遍历可用游玩历史，之后按保存的位置增量同步 |
| [国服 · 落雪](https://maimai.lxns.net/docs/api/chunithm) | 填写个人 API Token | 后台调用个人成绩 API；不是开发者 API Key |

本机运行时打开专用浏览器手动登录。Docker 部署时使用电脑登录助手：在网页生成绑定任务，将助手命令粘贴到已安装项目依赖的电脑终端，按提示隐藏输入绑定码，手动完成门户登录。后续同步由服务器完成，电脑无需在线。详细步骤见 [登录助手说明](docs/1panel.md)。

绑定码有效期 10 分钟，仅能提交一次；取消、重新生成、退出登录或服务重启会使未完成任务失效。助手只回传必要会话字段，不读取日常浏览器配置，不上传门户密码或 BCN Cookie。

- 同一来源操作期间防止重复提交；页面显示绑定身份、进度、最近成功时间与错误。
- 会话失效先尝试恢复；超时、分页失败、格式变化或账号 / 卡片不匹配时，不导入部分结果。
- 同账号同卡重新绑定保留大饼缓存；换卡、换账号或解绑会清理该来源缓存，已合并成绩保留。
- 大饼只能读取门户仍保存的游玩历史；缺失记录可通过文件导入补充。

<a id="records"></a>

## 成绩与导出

### 合并规则

默认只用**严格更高**的分数替换同谱面成绩，同分和较低分保留原分数与来源。手动改分允许调高或调低，范围为 `0–1,010,000` 的整数，来源显示「神秘游客」；之后同步取得更高分仍会更新。

MuNET 只有严格高于当前国服成绩时才覆盖国服。此前将国服成绩导入 MuNET 的用户，可以在国服卡片启用「国服覆盖 MuNET」，再同步或导入落雪文件，修复匹配记录的分数及来源标签。

达成标记通常与最高分独立合并，保留 `AJC > AJ > FC` 的最高标记和已知 FULL CHAIN 等级。更高分未附带标记时，不清除历史标记；手动改分保留标记，删除成绩同时删除标记。MuNET 未超过国服分数时整条跳过；国服修复模式按国服记录替换。

### 浏览与 Rating

两种成绩表均为每页 10 项，Rating 排名多一列名次。等级和定数联动：例如 `13` 只显示 `13.0–13.4`，`13+` 只显示 `13.5–13.9`。点击曲名打开详情卡，查看 EXP / MAS / ULT、成绩、评级和全部别名，也可编辑仅属于当前账号的个人别名。

单曲 Rating 使用项目内置 Mate 分段公式，截取四位小数，`1,009,000` 分达到定数 `+2.15` 上限。B30 取最高 30 张谱面，平均值固定除以 30，不足部分按零计；不计算 Recent 等其他游戏总 Rating 项。

### 导出与文件导入

| 内容 | 布局 / 格式 | 用途 |
| --- | --- | --- |
| 网页 B30 预览 | 3 × 10，默认折叠 | 在网页快速查看 |
| B30 图片 | 5 × 6 PNG | 分享 30 张最佳谱面 |
| B30 + 候选20 图片 | 5 × 10 PNG | 查看最佳成绩与候选谱面 |
| B30 / 候选20 JSON | OTO 成绩格式 | 导出 30 / 50 条成绩 |
| 完整备份 | `machun1-backup.json` | 保存全部成绩、来源、达成标记和个人别名 |

PNG 保留曲绘、定数、分数、评级、达成标记、Rating 与来源。远程曲绘不可用时使用占位图。完整备份不含门户绑定或凭据，B30 JSON 不等于完整备份。

每个来源提供独立文件导入，支持 MuNET / Rin 存档 JSON、大饼 `oto.json`、落雪成绩 CSV 或个人成绩 JSON；单文件最大 **10 MB**，不支持压缩包。导入只匹配评分曲库中的 EXP / MAS / ULT，不导入 BAS、ADV、WORLD’S END 或库外歌曲。

### 数据存放

| 位置 | 内容 |
| --- | --- |
| MySQL | 共享曲库；按用户保存成绩、别名、来源状态、Token、历史缓存和会话哈希 |
| `.machun.local/` 或容器 `/data` | 用户隔离的专用浏览器目录及旧迁移副本 |
| `.env` | 数据库连接和可选部署配置，排除 Git 与镜像 |
| `release/` | 本地镜像归档、部署包及校验文件，排除 Git 与镜像 |

旧版浏览器成绩仅在同源地址首次登录 `root` 时尝试迁移，成功后保留原 `localStorage` 副本；其他账号不读取这份数据。跨浏览器或访问地址恢复时使用完整备份。

<a id="development"></a>

## 开发

```bash
pnpm dev    # 网页 4399，API 4398，Vite 代理访问 API
pnpm test
pnpm build
```

<details>
<summary>数据库、部署与测试命令</summary>

| 命令 | 用途 |
| --- | --- |
| `pnpm start` | 构建后启动网页与 API，默认 4399 |
| `pnpm preview` | 启动已构建的 `dist/` 和 API，默认 4400 |
| `pnpm browser:install` | 安装 Playwright Chromium |
| `pnpm db:setup` | 显式执行远程迁移与应用账号初始化 |
| `pnpm db:tunnel` | 启动本机 SSH 数据库隧道 |
| `pnpm db:catalog` | 事务内更新共享曲库，不改变个人成绩 |
| `pnpm test:mysql` | 独立 MySQL 容器集成测试与 Chrome 网页检查 |
| `pnpm test:mysql --no-ui` | 仅运行 SQL 集成测试 |
| `pnpm docker:package` | 构建 amd64 镜像，导出镜像与一体部署包 |
| `pnpm docker:bundle` | 将已有镜像归档打成一体部署包 |
| `pnpm docker:hub-bundle` | 生成从 Hub 拉取镜像的小型部署包 |

普通测试默认跳过 MySQL 集成用例。`pnpm test:mysql` 需要本机 Docker 和 Google Chrome，使用隔离容器、随机凭据与回环端口，不读取项目 `.env` 或访问正式数据库，结束后清理测试资源。模拟门户测试不代替真实账号验收。

</details>

<details>
<summary>目录与曲库维护</summary>

```text
src/components/       成绩表、来源控制、详情卡和账号页面
src/core/             Rating、B30、解析、合并、筛选和导出
src/data/             评分曲库、详情补充和来源快照
server/providers/     四个成绩来源适配
server/db/            Drizzle 表、MySQL 连接与共享曲库
server/               登录、工作区事务、绑定任务与同步调度
db/migrations/        版本化 SQL
scripts/              曲库维护、数据库管理、打包与测试
```

曲库、分类、初出版本和远程曲绘参考 [OTOGE DB](https://github.com/zvuc/otoge-db) 与官方曲库，快照信息见 [catalog-sources.json](src/data/catalog-sources.json)。别名来自[落雪公开列表](https://maimai.lxns.net/docs/api/chunithm)及 [ChunithmUtil 社区快照](https://github.com/AmethystTim/ChunithmUtil/blob/abdddd70decc18540dc9fd8f21d37ab5fcfe8954/data/alias.json)。未知 BPM、物量及详情定数按现有未知表示保留，不推测填写。

```bash
pnpm catalog:refresh /path/to/music-ex.json /path/to/official-music.json 2026-10-08
node scripts/merge-aliases.mjs /path/to/alias-list.json
pnpm db:catalog
```

曲库更新保留既有别名及有效补充数据，支持已有歌曲新增 ULT；个人别名按用户独立保存。

</details>

<a id="faq"></a>

## 常见问题

| 问题 | 处理 |
| --- | --- |
| 拉取镜像后提示未配置 MySQL | 使用附带 Compose 启动；仅拉取镜像不会注入数据库连接 |
| 端口被占用 | 在原服务终端按 Ctrl+C；Docker 更新时保留项目名与数据卷 |
| 数据库不可用 | 检查连接、Docker 网络或 SSH 隧道；页面不会静默退回全局本地数据 |
| 登录或绑定过期 | 重新登录网页或生成来源绑定任务，不会删除已合并成绩 |
| 浏览器无法启动 | 执行 `pnpm browser:install`；本机 Google Chrome 可作为后备 |
| HTTP 418 / 门户限流 | 等待提示或重新登录，避免连续重复同步 |
| 导入有未知谱面 | 确认属于内置 13.0+ EXP / MAS / ULT，低定数详情不参与成绩导入 |
| 手机如何绑定来源 | 先在电脑完成登录助手绑定，再用手机进行日常同步 |

HTTP 会明文传输网页登录和助手会话；部署支持配置 `MACHUN_PUBLIC_ORIGIN` 使用 HTTPS 反代。绑定助手的真实桌面验收目标为 macOS，Linux amd64 容器验证结果及 MuNET 续期边界见 [验证记录](docs/companion-rollout.md)。

## 许可证与素材

项目代码采用 [Apache License 2.0](LICENSE)。本项目与 SEGA CORPORATION 及上述成绩服务无隶属关系；CHUNITHM 商标、曲绘、歌曲及外部曲库、别名素材归各自权利人所有，需遵守各自许可。仓库不保存远程曲绘图片。
