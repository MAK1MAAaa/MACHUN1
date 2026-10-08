# MACHUN1

在本机运行的 CHUNITHM Mate 成绩管理工具。通过网页管理综合最高分、计算单曲 Rating 和 B30，并从 MuNET、Rin服、大饼及国服落雪手动同步成绩。

采用 React、TypeScript、Vite、Node.js、mysql2 和 Drizzle。本分支使用 MySQL 保存账号数据；本机通过 SSH 隧道连接，Docker 通过 1Panel 网络连接数据库。门户登录采用电脑 Playwright 助手，部署端只运行无界面同步。只有登录页面，没有注册接口，不进行启动同步、定时同步或 QQ Bot。

## 功能概览

- **四个成绩来源**：分别绑定、同步、重新登录和解绑，也支持离线文件导入。
- **综合最高分**：同一歌曲和难度保留一条成绩，默认只接受更高分，标注其来源；可手动录入、改分和删除。
- **B30 与候选20**：网页 B30 预览为 3 列 × 10 行，普通 PNG 为 5 列 × 6 行，候选20 PNG 为 5 列 × 10 行；图片预览默认折叠，另有两种 JSON 导出。
- **评级与达成标记**：读取并保存 FC、AJ、AJC 及来源提供的 FULL CHAIN，成绩表、详情卡和分表图片统一显示 SSS+、SSS、SS+ 等评级。
- **成绩浏览**：Rating 排名与曲库筛选两种表格，每页 10 项；支持曲名、别名和 ID 搜索。
- **曲库筛选**：难度、等级、定数、分类、版本、成绩来源、未游玩谱面及分数排序。
- **歌曲详情**：点击曲名打开居中卡片，查看曲绘、ID、分类、版本、EXP/MAS/ULT 定数和成绩，别名默认全部展开。
- **用户隔离**：成绩、个人别名、来源绑定、落雪 Token 与大饼缓存按网页账号分别保存，曲库共享；提供完整成绩备份导入和导出。

当前评分曲库为截至 **2026-10-08** 的日服 Mate 数据，包含 **1,507 张 13.0+ 谱面、1,243 首歌曲**，仅支持 EXP、MAS、ULT。内置 **2,458 条别名，覆盖 800 首歌曲**。详情卡另有低定数补充数据，但不扩大成绩导入与 Rating 的范围。

## 环境要求

首版以 macOS 桌面环境为目标，其他系统尚未完成实际账号验收。

| 组件 | 要求 |
| --- | --- |
| Node.js | 建议使用 24.x；当前 Vite 依赖要求 `^20.19.0` 或 `>=22.12.0`，项目未单独声明 `engines`。 |
| pnpm | `package.json` 指定 `pnpm@10.15.0`。 |
| 浏览器 | 推荐现代 Chromium 浏览器；来源绑定需能弹出本机浏览器窗口。 |
| MySQL | 8.4；应用账号仅需 `machun1.*` 的 SELECT / INSERT / UPDATE / DELETE。建表使用单独管理连接。 |
| 网络 | 登录和数据读写需要可用的 MySQL / SSH 隧道；来源同步和远程曲绘还需访问门户。 |

## 快速开始

```bash
git clone git@github.com:MAK1MAAaa/MACHUN1.git
cd MACHUN1
pnpm install
pnpm browser:install

# 服务器恢复后，显式执行一次；会通过 ssh tencent 建库、建表和创建专用账号
pnpm db:setup

# 保持该终端运行；Ctrl+C 关闭 SSH 隧道
pnpm db:tunnel

# 在第二个终端初始化共享曲库，再启动网页
pnpm db:catalog
pnpm start
```

打开 [http://127.0.0.1:4399/](http://127.0.0.1:4399/)，首次网页账号为 `root`，密码为 `pwd`。`pnpm start` 会先检查 TypeScript 并构建网页，再启动网页和同步后台。

`pnpm browser:install` 首次安装 Playwright Chromium。若未安装，程序会尝试本机 Google Chrome，但仍使用工具专属会话目录，不读取日常浏览器配置；没有可用浏览器时页面会提示安装。

在启动服务的终端按 **Ctrl+C** 停止进程。专用浏览器和正在等待的同步会随服务关闭，已保存的成绩与绑定保留；SSH 隧道在其终端单独按 Ctrl+C 关闭。

### 运行命令

| 命令 | 用途 |
| --- | --- |
| `pnpm start` | 构建并启动正式本地服务，网页与 API 使用 `127.0.0.1:4399`。 |
| `pnpm dev` | 启动 Vite 网页 `127.0.0.1:4399` 和同步 API `127.0.0.1:4398`，网页通过代理访问 API。 |
| `pnpm build` | 执行 `tsc -b` 和 Vite 构建，产物写入 `dist/`。 |
| `pnpm preview` | 启动现有 `dist/` 和同步 API，访问 `127.0.0.1:4400`；需先构建。 |
| `pnpm browser:install` | 安装用于来源登录的 Chromium。 |
| `pnpm db:setup` | 通过 `ssh tencent` 和 MySQL 管理连接执行版本化 SQL，创建专用账号，将随机连接密码写入受限 `.env`；重复运行不重置已有网页密码。 |
| `pnpm db:tunnel` | 本机 `127.0.0.1:13306` 转发服务器 `127.0.0.1:3306`。 |
| `pnpm db:catalog` | 在事务内更新 MySQL 共享曲库，不改变个人成绩。 |
| `pnpm test` | 执行不依赖数据库的 Vitest 测试；MySQL 集成测试默认跳过。 |
| `pnpm test:mysql` | 创建本机独立 MySQL 8.4 容器，运行真实 SQL 集成测试及 Chrome 网页检查，结束后自动清理；不使用项目 `.env` 或腾讯服务器。 |
| `pnpm test:watch` | 以监听模式运行 Vitest。 |

一次运行一种服务模式即可。服务仅监听 `127.0.0.1`，校验 Host、请求来源和本地 API 标记，不开放跨站访问。

**成绩以 MySQL 为准，按用户名保存。** 登录同一账号后，不同浏览器和本地访问地址可读取相同成绩。登录 Cookie 随访问地址保存；旧版浏览器成绩仍需在原来的 `http://127.0.0.1:4399` 首次登录 `root` 时迁移。当前服务器操作及真实数据迁移状态见 [本轮任务记录](docs/mysql-rollout.md)。

## 登录和数据库

用户表严格为两列：`username VARCHAR(64)` 主键和 `pwd CHAR(64)`。用户名区分大小写，`pwd` 保存 UTF-8 SHA-256 的小写十六进制哈希，不保存明文密码。初始化仅在 `root` 不存在时插入 `SHA256("pwd")`，重复迁移不会重置已有密码。增加用户需使用数据库管理连接手动插入；没有网页注册功能。

登录签发随机会话 Cookie，使用 `HttpOnly`、`SameSite=Lax`，有效期七天；数据库只保存令牌哈希，退出登录撤销当前会话。用户名不存在和密码错误使用同一提示，同一客户端对同一用户名连续失败五次后限制十五分钟。

`.env` 的 `DATABASE_URL` 由 `db:setup` 自动生成，文件权限设为 `0600`，原有门户配置保留。已手工配置其他连接地址时，该命令拒绝覆盖，请通过管理连接执行 [迁移 SQL](db/migrations/0001_accounts.sql)，使用专用账号配置连接。应用运行和 `db:catalog` 都不使用管理账号。`db:setup` 不会随 `start` 或 `dev` 自动运行。

API 包括 `POST /api/auth/login`、`GET /api/auth/session`、`POST /api/auth/logout`、`GET /api/catalog`、`GET /api/workspace`、`POST /api/workspace/actions` 和一次性 `POST /api/workspace/migrate`。除登录状态和登录接口外，所有成绩、曲库及来源接口都要求有效会话，用户名只取自会话。接口不返回密码哈希、门户 Cookie 或 Token。

成绩写入在事务内锁定当前用户的工作区，读取最新数据后执行改分、导入或合并，并增加工作区版本号。前端忽略较旧版本及上一账号的迟到响应。数据库不可用时明确提示错误，保留当前页面数据，不改用旧全局 `localStorage`，不报告保存成功。

## 绑定与同步

展开“成绩来源”，绑定对应账号后，点击该来源的“同步成绩”。每个网页用户的每个来源绑定一个账号；同一来源操作期间防止重复提交，页面显示绑定身份、进度、最近成功时间和错误。

| 来源 | 绑定方式 | 同步方式与注意事项 |
| --- | --- | --- |
| [MuNET](https://portal.mumur.net/user) | 在专用浏览器登录账号，完成滑块或验证码。 | 读取当前账号的 CHUNITHM 存档成绩；会话失效时重新登录。 |
| [Rin服](https://portal.naominet.live/) | 在门户登录，绑定当时的默认 Aime 卡。 | 后续固定同步该卡，并核对卡仍属于当前账号；不更改门户默认卡。切换卡时先在门户设置默认卡，再重新绑定。 |
| [大饼](https://u.otogame.net/) | 在门户登录，绑定当前主卡。 | 首次和全量校准均遍历游玩历史，之后按保存的位置增量同步。主卡或账号改变时要求重新绑定，不自动修改主卡。 |
| [国服 · 落雪](https://maimai.lxns.net/docs/api/chunithm) | 填写并保存个人 API Token。 | 后台通过个人成绩 API 同步；绑定后输入框清空，Token 保存在本机，可直接再次同步。不是开发者 API Key。 |

程序优先复用登录状态，可续期的会话先尝试恢复；仍失效时提示重新登录。网页状态轮询仅查询操作进度，不会定时同步成绩。超时、格式变化、分页失败或身份不匹配时，本次同步失败，保留已有成绩。

### 大饼历史同步

首次同步分页读取门户仍保留的全部游玩历史，按曲名和难度合并最高分，不读取乐曲成绩全表或只读取 Rating 榜。成功后保存最新时间戳及同秒记录指纹，下一次只读取上次位置之后的记录。

规范化成绩缓存与同步位置按用户名在 MySQL 中一起保存，整次成功后才推进位置；同步响应丢失时，下一次可通过完整缓存恢复成绩。首次同步无法恢复门户已经删除的历史，可使用文件导入补充。“全量校准”重新遍历历史并保留已有缓存最高分；同账号同卡重新登录保留缓存，换账号、换卡或解绑会清除后台缓存。

请求有间隔，限流时按服务器提示等待并显示进度。每页最多重试 3 次，单次等待上限 15 分钟，一次同步累计等待上限 35 分钟。历史很多时请保持服务和页面运行；乱序、分页位置变化或失败不会导入部分结果，也不会推进同步位置。

### Docker 部署与本机登录助手

当前 `codex/manual-login-docker` 分支使用 MySQL 多用户账户。部署端没有 VNC 或密码自动填写；电脑手动完成门户登录后，手机可独立同步。`main` 保留本机门户自动登录能力。

1. 电脑安装 Node.js 24、pnpm，检出与镜像匹配的分支，运行 `pnpm install` 和 `pnpm browser:install`。
2. 部署网页登录后，展开来源工具，点击“绑定账号 / 重新登录”，生成绑定任务。
3. 在电脑项目目录粘贴网页助手命令，例如：

```bash
pnpm login:remote --server https://chuni.example.com --task <网页任务ID>
```

4. 终端提示时粘贴绑定码，输入不会显示；绑定码不放入命令、URL 或 `.env`。
5. 在独立官方门户窗口手动登录并完成验证码，助手自动回传必要的登录状态。服务器核对账号和卡片后，网页显示绑定成功。

绑定码仅保存哈希，10 分钟有效、仅能提交一次。取消、重新生成、网页退出、网页会话失效或服务重启后未完成任务作废。响应丢失时重新运行同一命令会查询结果，不重复提交。只传三个来源必要的 localStorage Token 字段，排除门户密码、BCN Cookie、个人日常浏览器目录。助手临时目录结束后清理。

可移植会话按用户和来源存入 MySQL，续期后更新；服务器无界面 Chromium 完成后续取分，电脑无需在线。原浏览器目录仍兼容，但服务器没有目录时需用助手重新绑定，已合并成绩不受影响。同账号同卡重新绑定保留大饼缓存，验证失败保留旧绑定。落雪仍填写个人 API Token。

详见 [1Panel 部署说明](docs/1panel.md)。构建命令 `pnpm docker:package` 生成 `release/machun1-companion-20261008-amd64-1650.tar.gz` 和 `.sha256`；旧 1650 归档保留。镜像端口与宿主机入口均为 1650，通过 HTTPS 域名反代。数据库迁移必须由管理连接显式执行，应用只使用 CRUD 账号，不自动迁移正式库。

## 文件导入与成绩规则

每个来源卡片提供独立文件导入入口，单文件最大 **10 MB**，不支持压缩包。

| 来源 | 支持的文件 |
| --- | --- |
| MuNET | CHUNITHM JSON 存档的 `userMusicDetailList[].musicId / level / scoreMax`；若带 `gameId`，须为 `SDHD`。 |
| Rin服 | 门户导出的 `chusan_*_exported.json`，读取 `userMusicDetailList` 最高分。 |
| 大饼 | `oto.json`，包括 `data.*_rating_list`，兼容常见 Rating/Record JSON 成绩字段。 |
| 国服 · 落雪 | `chunithm-scores.csv` 或个人成绩 API JSON。 |

数字难度 `2 / 3 / 4` 对应 EXP / MAS / ULT。成绩按 ID 或唯一正式曲名与难度匹配评分曲库，定数和 Rating 由后台按数据库曲库重新计算；未知谱面和无效记录会在解析统计中显示。原始存档中的账号设置、日志等字段不会进入成绩存储。

### 合并规则

1. 默认只在新分数严格更高时替换同谱面成绩，同分和较低分保留已有分数及来源。
2. **MuNET 只有严格高于当前国服成绩时，才覆盖国服分数及标签。** 同分或更低分保留国服；同步和文件导入均适用。
3. 手动录入和改分可提高或降低分数，范围为 `0–1,010,000` 的整数，来源显示“神秘游客”。之后同步获得更高分仍可更新。
4. 曾将国服数据导入 MuNET 时，可在国服卡片启用 **“国服覆盖 MuNET”**，再同步或导入落雪文件。只替换此次匹配且当前来源为 MuNET 的记录，允许同分和较低分覆盖并改回国服标签；其他来源仍按最高分合并，未匹配记录与个人别名保留。

国服修复模式默认关闭，刷新页面后恢复关闭。同步结果合并到数据库中该用户的最新工作区，保留等待期间的手动修改与其他同步结果，并按以上规则决定是否更新。

达成标记与最高分独立保存：同一谱面保留 `AJC > AJ > FC` 的最高标记，即使取得标记的那次游玩分数更低，也可补齐标记，已有分数和来源不变；更高分未附带标记时不清除历史标记。FULL CHAIN 同样保留已知最高级别，只有布尔值时显示通用 `FCHAIN`。手动改分保留已获得标记；删除成绩同时删除标记。MuNET 未超过国服分数时仍整条跳过；“国服覆盖 MuNET”修复会以国服的分数和标记替换 MuNET 记录。

Rin、MuNET、大饼的 `isFullCombo / isAllJustice` 与落雪的 `full_combo` 会转换为统一字段。来源成绩达到 `1,010,000` 时识别为 AJC；其余分数不会推断 FC 或 AJ。旧版本已经丢弃的标记无法从分数恢复，需重新同步或导入原文件；大饼可通过“全量校准”重读门户尚存的历史记录，普通同步继续沿用原增量位置。

## 浏览、详情与导出

### 表格与歌曲详情

“Rating 排名”按单曲 Rating 排序并支持搜索；“曲库筛选”显示筛选后的谱面，均为每页 10 项。两种表格的列一致，Rating 额外在最左侧显示排名。表格左对齐并带列分隔线，窄屏可横向滚动；长曲名单行省略，悬停显示全文，点击打开详情。

曲库筛选位于表格上方。等级与定数联动：`13` 只显示 `13.0–13.4`，`13+` 只显示 `13.5–13.9`，其他等级同理；切换等级时清除不匹配的定数。版本表示歌曲初出版本，来源表示当前综合成绩的归属。选择特定来源时不显示未游玩谱面；选择全部来源后可启用“显示未游玩谱面”。

点击曲库的“分数”表头，循环切换默认排序、分数降序、分数升序，未游玩始终排在末尾。改变筛选或排序回到第一页，“清除筛选”同时重置搜索、排序和未游玩开关。

详情卡固定保留 EXP、MAS、ULT 三行，缺失或未知定数显示 `/`，无成绩时分数留空；有成绩时显示分数、评级和达成标记。曲库别名与个人别名合并去重、默认展开，不显示作者及游玩记录按钮。详情卡还可编辑个人别名，每行一个，仅影响当前账号。使用关闭按钮、Esc 或点击卡片外部关闭。

### Rating 与 B30

单曲 Rating 采用项目内置 Mate 分段公式，计算结果截取四位小数；`1,009,000` 分达到定数 `+2.15` 上限。B30 取单曲 Rating 最高的 30 张谱面，平均值固定除以 30，不足 30 条的空槽按零贡献处理；不计算 Recent 等其他游戏总 Rating 项。

柱状图高度为 360px。上界为 `B1 + 0.2` 向下取到一位小数，下界为 `B30 − 0.2` 向上取到一位小数，不足 30 条使用当前末位。上界显示淡色参考线；原中点标签改为 B30 平均 Rating 向下取两位小数的参考值，按数值定位，超出当前纵轴范围时不绘制该参考线。

### 导出

| 按钮 | 内容 |
| --- | --- |
| 导出 B30 图片 | 5 列 × 6 行 B30 PNG，保留曲绘、定数、成绩、评级、达成标记、Rating 和来源标签。 |
| 导出 B30 + 候选20 图片 | 5 列 × 10 行共 50 槽 PNG，同样显示评级和达成标记；前 30 为 B30，后 20 为候选，候选不参与 B30 平均值。 |
| 导出完整备份 | `machun1-backup.json`，保存当前账号全部成绩、来源、达成标记和个人别名，不含绑定及凭据。 |
| 导入完整备份 | 在“账号数据”选择合并最高分或替换全部，恢复其他浏览器及访问地址的旧备份。 |
| 导出 B30 JSON | `b30.json`，按 OTO 格式保存 `data.base_rating_list`。 |
| 导出 B30 + 候选20 JSON | `b30-candidates20.json`，另用 `next_rating_list` 保存排名 31–50。 |

JSON 仅导出已有记录，含 `song_id`、曲名、难度、分数，以及存在时的 `full_combo / full_chain`，可从大饼 JSON 入口重新导入并保留达成标记；不包含账号、Token 或 Cookie。重新导入时按入口标记来源，并按当前曲库重算 Rating 和评级。曲绘加载失败时 PNG 使用占位图。**这些 JSON 不是全部本地成绩与个人别名的完整备份。**

## 数据迁移与备份

`root` 首次登录会尝试一次性导入同源浏览器旧版 `chunithm-mate-b30:v2`（兼容 v1）成绩和个人别名，成功后在数据库记录标记。原 `localStorage` 副本不删除，也不继续写入；其他用户不读取这份旧数据。失败不会标记完成或删除原副本，重新登录可重试。其他浏览器或地址使用“导入完整备份”恢复。

旧 `.machun.local/<来源>.json`、Token、大饼缓存和登录目录迁入 `root`。原文件保留作为迁移副本，成功标记防止重启后重复绑定。浏览器目录复制成功后才提交来源迁移；迁移时先关闭旧门户窗口。真实迁移数量以操作完成后的报告为准。

| 位置 | 保存内容 | 清理行为 |
| --- | --- | --- |
| MySQL `machun1` | 共享曲库；按用户保存成绩、个人别名、来源绑定、Token、大饼同步位置和网页会话哈希。 | “清空当前账号数据”仅删除该用户的成绩和个人别名；解绑删除该用户对应绑定与缓存。 |
| `.machun.local/users/<用户名 SHA-256>/profiles/` | 每位用户独立的门户浏览器目录。 | 解绑移除对应用户的当前浏览器目录，保留已经合并的成绩和旧迁移副本。 |
| 原浏览器 `localStorage` 与旧 `.machun.local/` 文件 | 一次性迁移的原副本。 | 应用保留，不自动覆盖或清理。 |
| `.env` | MySQL 连接及 HTTPS 访问地址。 | 不因网页清空或解绑而删除。 |

本地浏览器目录权限为 `0700`，`.env` 为 `0600`。正式模式只公开 `dist/`，开发模式屏蔽凭据及会话文件。个人导出、数据库连接和浏览器目录均由 `.gitignore` 排除。

完整备份支持成绩和个人别名的合并或替换；B30 JSON 仅能恢复导出的 30 / 50 条，不是完整备份。旧 `localStorage` 的原值使用成绩对象映射，完整备份导入也兼容该格式。文件导入不会导入门户凭据。换机器需保留数据库、迁移专用浏览器目录，或重新绑定来源；不要分享 `.env`、浏览器目录或原始账号存档。

## 项目结构

```text
src/
  App.tsx                      用户工作区与成绩界面
  components/                  来源控制、成绩表格和歌曲详情卡
  core/                        Rating、B30、导入、合并、筛选、存储与导出
  data/catalog.json            13.0+ 评分曲库及内置别名
  data/song-chart-details.json  详情卡补充谱面定数
  types.ts / accountTypes.ts    曲库、成绩及共享账号接口类型
  syncTypes.ts                 前后端共享同步类型
server/
  index.ts / http.ts            本机服务、API 和静态资源
  auth.ts / workspace.ts       登录会话、事务化用户数据操作
  accountService.ts / db/       用户来源隔离、Drizzle 表和 MySQL 连接
  manager.ts / store.ts         绑定、同步调度与浏览器目录
  bindingTasks.ts / portableSession.ts 一次性绑定任务与最小会话
  providers/                   四个成绩来源的接口适配
db/migrations/                 受版本管理的 SQL
scripts/                       曲库维护、数据库管理和隔离测试
.env.example                   无凭据的 MySQL 与部署模板
```

## 曲库与别名维护

曲库和远程曲绘地址参考 [OTOGE DB](https://github.com/zvuc/otoge-db)。分类取上游 `catname`，版本取歌曲级 `version`，`AIR+` 等统一显示为 `AIR PLUS`。上游未知 BPM 用 `null` 表示，不影响成绩匹配与 Rating。

评分曲库更新使用官方歌曲编号、现有上游快照和已核实的定数补充。新增脚本支持全部 13.0+ 谱面，包括已有歌曲的新 ULT；保留既有别名和有效补充数据。缺少 BPM 用 `null`，缺少物量用全零，详情未知定数不填，页面显示 `/`。

```bash
pnpm catalog:refresh /path/to/music-ex.json /path/to/official-music.json 2026-10-08
node scripts/merge-aliases.mjs /path/to/alias-list.json

# 检查本地数据后，服务器恢复时显式更新共享数据库曲库
pnpm db:catalog
```

快照来源及上游提交号见 [catalog-sources.json](src/data/catalog-sources.json)。10 月 8 日图表的五张 MAS 加入评分曲库，SAN値直葬 EXP 12.5、ハイボルテージガール EXP 11.9、コンクエスト・チャレンジ EXP 11.3 只加入详情；9 月 25 日三张 MAS 和「きゅうくらりん」ULT 15.0 也已加入。评分仍用本项目原有口径。

别名来自[落雪公开列表](https://maimai.lxns.net/docs/api/chunithm)及 [ChunithmUtil 社区快照](https://github.com/AmethystTim/ChunithmUtil/blob/abdddd70decc18540dc9fd8f21d37ab5fcfe8954/data/alias.json)，不是 MuNET 别名的完整镜像。合并脚本支持落雪 `aliases` 和社区 `songs[].cid / aliases` 格式；数字编号按 ID 匹配，旧版正式曲名仅在规范化后唯一精确匹配时合并。别名按 Unicode 规范化去重，同一歌曲的所有谱面共享，个人别名按用户独立保存在 MySQL。

落雪列表可下载后再合并：

```bash
curl -L https://maimai.lxns.net/api/v0/chunithm/alias/list -o /tmp/lxns-chunithm-aliases.json
node scripts/merge-aliases.mjs /tmp/lxns-chunithm-aliases.json
```

## 开发与检查

```bash
pnpm dev
pnpm test
pnpm build
```

Vitest 覆盖 Rating、成绩解析与合并、来源适配、历史分页、会话和本地接口。真实 MySQL 及网页验收单独运行：

```bash
pnpm build
pnpm test:mysql          # 需要本机 Docker Desktop 和 Google Chrome；只启动本机测试容器
pnpm test:mysql --no-ui  # 只运行 MySQL 集成测试
pnpm exec tsx scripts/smoke-sessions.ts
pnpm exec tsx scripts/smoke-auto-login.ts
```

测试容器使用随机管理凭据、随机回环端口和临时内存卷，应用连接仅有 CRUD 权限；测试脚本不读取项目 `.env`、真实浏览器目录或腾讯 MySQL。结束后停止容器、删除临时凭据，网页截图及导出结果存放在系统临时目录。当前验收与待办见 [本轮任务记录](docs/mysql-rollout.md)。模拟门户验证不代替四个来源的真实账号验收。

## 常见问题与边界

- **端口已占用**：在先前启动服务的终端按 Ctrl+C，再启动需要的模式；`start` 与 `dev` 都占用 4399。
- **网页有成绩，但同步服务无法连接**：启动 `pnpm start`，或开发模式下确认网页和 API 两个进程都在运行。`preview` 应访问 4400。
- **重启后看不到成绩**：确认 SSH 隧道、数据库和登录用户；登录后的数据来自 MySQL。旧浏览器数据只有 root 首次迁移会读取，其他地址使用完整备份导入。
- **浏览器无法启动**：执行 `pnpm browser:install`，并确认有可用桌面环境。已安装 Google Chrome 可作为后备。
- **会话过期或卡片改变**：点击重新登录/重新绑定；Rin 使用绑定时选中的卡，大饼要求主卡一致。
- **HTTP 418、限流或门户格式变化**：可能需要在专用浏览器重新登录或等待；不要连续重复同步。当前同步失败不会修改已有成绩，但外部接口变化仍可能需要更新适配代码。
- **导入有未知谱面**：只支持内置 13.0+ EXP/MAS/ULT；BAS、ADV、WORLD’S END 和库外歌曲不会导入。详情卡中的低定数仅供展示。
- **PNG 没有部分曲绘**：远程图片可能不可用，程序使用占位图，不影响成绩和 Rating。

本工具不提供注册、管理员界面、自动/定时同步或 QQ Bot；当前 main 不提供 Docker 部署。四个门户接口可能变化；首次大饼历史同步仅能读取门户尚存的数据。

## Git 提交与推送

远程仓库使用 SSH：`git@github.com:MAK1MAAaa/MACHUN1.git`。需将本机 SSH 公钥加入有仓库写权限的 GitHub 账号。

首次推送已经整理好的本地提交：

```bash
git remote -v
git status --short
git log -1 --oneline
git push -u origin main
```

后续修改时先检查内容，再提交并推送：

```bash
git diff
git add README.md docs db src server scripts package.json pnpm-lock.yaml vite.config.ts .env.example .gitignore
git diff --cached --stat
git commit -m "feat: 更新成绩管理功能"
git push
```

按实际修改选择文件，并确认暂存区不包含账号文件、个人成绩备份或导入的原始存档。若推送提示远程有新的提交，先 `git fetch origin` 并检查差异，再合并或变基；不要使用强制推送覆盖远程提交。

## 许可证与非官方声明

项目源代码沿用仓库已有的 [Apache License 2.0](LICENSE)。外部曲库、别名、曲绘、歌曲和其他素材不因此统一适用该许可证，应遵守各自来源的许可与权利声明。

本工具与 SEGA CORPORATION 及上述成绩服务无隶属关系。CHUNITHM 和相关商标、曲绘、歌曲及其他素材归各自权利人所有。曲绘使用 OTOGE DB 的公开远程地址，仓库不保存图片文件。

Docker 分支的验收范围、三服真实会话移植结果及 MuNET 续期限制见 [本机助手验证记录](docs/companion-rollout.md)。
