# MACHUN1

在本机运行的 CHUNITHM Mate 成绩管理工具。通过网页管理综合最高分、计算单曲 Rating 和 B30，并从 MuNET、Rin服、大饼及国服落雪手动同步成绩。

采用 React、TypeScript、Vite 和 Node.js，网页登录由 Playwright 完成。仅供本地使用，无独立数据库、定时同步或 QQ Bot。

## 功能概览

- **四个成绩来源**：分别绑定、同步、重新登录和解绑，也支持离线文件导入。
- **综合最高分**：同一歌曲和难度保留一条成绩，默认只接受更高分，标注其来源；可手动录入、改分和删除。
- **B30 与候选20**：自动排名，提供两种 PNG 和两种 JSON 导出；图片预览默认折叠。
- **成绩浏览**：Rating 排名与曲库筛选两种表格，每页 10 项；支持曲名、别名和 ID 搜索。
- **曲库筛选**：难度、等级、定数、分类、版本、成绩来源、未游玩谱面及分数排序。
- **歌曲详情**：点击曲名打开居中卡片，查看曲绘、ID、分类、版本、EXP/MAS/ULT 定数和成绩，别名默认全部展开。
- **本地保存**：浏览器保存成绩和个人别名，后台保存独立登录会话及落雪 Token；页面与导出不返回这些凭据。

当前评分曲库为截至 **2026-09-17** 的日服 Mate 数据，包含 **1,498 张 13.0+ 谱面、1,235 首歌曲**，仅支持 EXP、MAS、ULT。内置 **2,458 条别名，覆盖 800 首歌曲**。详情卡另有低定数补充数据，但不扩大成绩导入与 Rating 的范围。

## 环境要求

首版以 macOS 桌面环境为目标，其他系统尚未完成实际账号验收。

| 组件 | 要求 |
| --- | --- |
| Node.js | 建议使用 24.x；当前 Vite 依赖要求 `^20.19.0` 或 `>=22.12.0`，项目未单独声明 `engines`。 |
| pnpm | `package.json` 指定 `pnpm@10.15.0`。 |
| 浏览器 | 推荐现代 Chromium 浏览器；来源绑定需能弹出本机浏览器窗口。 |
| 网络 | 来源登录、同步和远程曲绘需要联网；服务启动后，手动管理和文件导入不依赖来源网站登录。 |

## 快速开始

```bash
git clone git@github.com:MAK1MAAaa/MACHUN1.git
cd MACHUN1
pnpm install
pnpm browser:install
pnpm start
```

打开 [http://127.0.0.1:4399/](http://127.0.0.1:4399/)。`pnpm start` 会先检查 TypeScript 并构建网页，再启动网页和同步后台。

`pnpm browser:install` 首次安装 Playwright Chromium。若未安装，程序会尝试本机 Google Chrome，但仍使用工具专属会话目录，不读取日常浏览器配置；没有可用浏览器时页面会提示安装。

在启动服务的终端按 **Ctrl+C** 停止进程。专用浏览器和正在等待的同步会随服务关闭，已保存的成绩与绑定保留。

### 运行命令

| 命令 | 用途 |
| --- | --- |
| `pnpm start` | 构建并启动正式本地服务，网页与 API 使用 `127.0.0.1:4399`。 |
| `pnpm dev` | 启动 Vite 网页 `127.0.0.1:4399` 和同步 API `127.0.0.1:4398`，网页通过代理访问 API。 |
| `pnpm build` | 执行 `tsc -b` 和 Vite 构建，产物写入 `dist/`。 |
| `pnpm preview` | 启动现有 `dist/` 和同步 API，访问 `127.0.0.1:4400`；需先构建。 |
| `pnpm browser:install` | 安装用于来源登录的 Chromium。 |
| `pnpm test` | 执行 Vitest 测试。 |
| `pnpm test:watch` | 以监听模式运行 Vitest。 |

一次运行一种服务模式即可。服务仅监听 `127.0.0.1`，校验 Host、请求来源和本地 API 标记，不开放跨站访问。

**成绩按浏览器和访问地址分别保存。** `4399` 与 `4400`、`127.0.0.1` 与 `localhost` 的 `localStorage` 不共享。开发和正式模式都使用 `http://127.0.0.1:4399/` 时，可继续读取同一浏览器中的成绩。

## 绑定与同步

展开“成绩来源”，绑定对应账号后，点击该来源的“同步成绩”。每个来源绑定一个账号；同一来源操作期间防止重复提交，页面显示绑定身份、进度、最近成功时间和错误。

| 来源 | 绑定方式 | 同步方式与注意事项 |
| --- | --- | --- |
| [MuNET](https://portal.mumur.net/user) | 在专用浏览器登录账号，完成滑块或验证码。 | 读取当前账号的 CHUNITHM 存档成绩；会话失效时重新登录。 |
| [Rin服](https://portal.naominet.live/) | 在门户登录，绑定当时的默认 Aime 卡。 | 后续固定同步该卡，并核对卡仍属于当前账号；不更改门户默认卡。切换卡时先在门户设置默认卡，再重新绑定。 |
| [大饼](https://u.otogame.net/) | 在门户登录，绑定当前主卡。 | 首次和全量校准均遍历游玩历史，之后按保存的位置增量同步。主卡或账号改变时要求重新绑定，不自动修改主卡。 |
| [国服 · 落雪](https://maimai.lxns.net/docs/api/chunithm) | 填写并保存个人 API Token。 | 后台通过个人成绩 API 同步；绑定后输入框清空，Token 保存在本机，可直接再次同步。不是开发者 API Key。 |

程序优先复用登录状态，可续期的会话先尝试恢复；仍失效时提示重新登录。网页状态轮询仅查询操作进度，不会定时同步成绩。超时、格式变化、分页失败或身份不匹配时，本次同步失败，保留已有成绩。

### 大饼历史同步

首次同步分页读取门户仍保留的全部游玩历史，按曲名和难度合并最高分，不读取乐曲成绩全表或只读取 Rating 榜。成功后保存最新时间戳及同秒记录指纹，下一次只读取上次位置之后的记录。

规范化成绩缓存与同步位置一起原子保存，整次成功后才推进位置；同步响应丢失时，下一次可通过完整缓存恢复成绩。首次同步无法恢复门户已经删除的历史，可使用文件导入补充。“全量校准”重新遍历历史并保留已有缓存最高分；同账号同卡重新登录保留缓存，换账号、换卡或解绑会清除后台缓存。

请求有间隔，限流时按服务器提示等待并显示进度。每页最多重试 3 次，单次等待上限 15 分钟，一次同步累计等待上限 35 分钟。历史很多时请保持服务和页面运行；乱序、分页位置变化或失败不会导入部分结果，也不会推进同步位置。

### 可选自动登录

复制模板后填入本地配置：

```bash
cp -n .env.example .env
chmod 600 .env
```

上述复制命令不会覆盖已有 `.env`；已有配置时直接编辑现有文件。模板只包含以下空变量：

```dotenv
BCN_EMAIL=
BCN_PASSWORD=
MUNET_USERNAME=
MUNET_PASSWORD=
```

- Rin服和大饼共用 BCN 邮箱密码，自动选择 BEMANICN 入口，在核实的官方登录表单中填入。
- MuNET 使用用户名和密码自动填写登录表单，滑块、验证码、二次验证或授权确认仍需手动完成。
- 点击“绑定账号”或“重新登录”时才执行；每个绑定窗口最多自动提交一次，失败不会循环重试，已有输入内容时交由用户继续操作。
- 空值使用手动登录；后台同步继续复用会话。修改文件后重新打开绑定窗口即可读取，同名进程环境变量优先。
- 含 `#` 或空格的值应加引号。凭据不要使用 `VITE_` 前缀，避免进入前端构建。

`.env` 是本机明文凭据文件，仅供后台读取，不写入成绩、API 响应或导出。不要提交或分享填写后的文件。

## 文件导入与成绩规则

每个来源卡片提供独立文件导入入口，单文件最大 **10 MB**，不支持压缩包。

| 来源 | 支持的文件 |
| --- | --- |
| MuNET | CHUNITHM JSON 存档的 `userMusicDetailList[].musicId / level / scoreMax`；若带 `gameId`，须为 `SDHD`。 |
| Rin服 | 门户导出的 `chusan_*_exported.json`，读取 `userMusicDetailList` 最高分。 |
| 大饼 | `oto.json`，包括 `data.*_rating_list`，兼容常见 Rating/Record JSON 成绩字段。 |
| 国服 · 落雪 | `chunithm-scores.csv` 或个人成绩 API JSON。 |

数字难度 `2 / 3 / 4` 对应 EXP / MAS / ULT。成绩按 ID 或唯一正式曲名与难度匹配评分曲库，定数和 Rating 使用内置数据重新计算；未知谱面和无效记录会在解析统计中显示。原始存档中的账号设置、日志等字段不会进入成绩存储。

### 合并规则

1. 默认只在新分数严格更高时替换同谱面成绩，同分和较低分保留已有分数及来源。
2. **MuNET 只有严格高于当前国服成绩时，才覆盖国服分数及标签。** 同分或更低分保留国服；同步和文件导入均适用。
3. 手动录入和改分可提高或降低分数，范围为 `0–1,010,000` 的整数，来源显示“神秘游客”。之后同步获得更高分仍可更新。
4. 曾将国服数据导入 MuNET 时，可在国服卡片启用 **“国服覆盖 MuNET”**，再同步或导入落雪文件。只替换此次匹配且当前来源为 MuNET 的记录，允许同分和较低分覆盖并改回国服标签；其他来源仍按最高分合并，未匹配记录与个人别名保留。

国服修复模式默认关闭，刷新页面后恢复关闭。同步结果合并到响应到达时的最新页面状态，保留等待期间的手动修改与其他同步结果，并按以上规则决定是否更新。

## 浏览、详情与导出

### 表格与歌曲详情

“Rating 排名”按单曲 Rating 排序并支持搜索；“曲库筛选”显示筛选后的谱面，均为每页 10 项。两种表格的列一致，Rating 额外在最左侧显示排名。表格左对齐并带列分隔线，窄屏可横向滚动；长曲名单行省略，悬停显示全文，点击打开详情。

曲库筛选位于表格上方。等级与定数联动：`13` 只显示 `13.0–13.4`，`13+` 只显示 `13.5–13.9`，其他等级同理；切换等级时清除不匹配的定数。版本表示歌曲初出版本，来源表示当前综合成绩的归属。选择特定来源时不显示未游玩谱面；选择全部来源后可启用“显示未游玩谱面”。

点击曲库的“分数”表头，循环切换默认排序、分数降序、分数升序，未游玩始终排在末尾。改变筛选或排序回到第一页，“清除筛选”同时重置搜索、排序和未游玩开关。

详情卡固定保留 EXP、MAS、ULT 三行，缺失或未知定数显示 `/`，无成绩时分数留空。曲库别名与个人别名合并去重、默认展开，不显示作者及游玩记录按钮。使用关闭按钮、Esc 或点击卡片外部关闭。

### Rating 与 B30

单曲 Rating 采用项目内置 Mate 分段公式，计算结果截取四位小数；`1,009,000` 分达到定数 `+2.15` 上限。B30 取单曲 Rating 最高的 30 张谱面，平均值固定除以 30，不足 30 条的空槽按零贡献处理；不计算 Recent 等其他游戏总 Rating 项。

柱状图高度为 360px。上界为 `B1 + 0.2` 向下取到一位小数，下界为 `B30 − 0.2` 向上取到一位小数，不足 30 条使用当前末位。上界显示淡色参考线；原中点标签改为 B30 平均 Rating 向下取两位小数的参考值，按数值定位，超出当前纵轴范围时不绘制该参考线。

### 导出

| 按钮 | 内容 |
| --- | --- |
| 导出 B30 图片 | 3 列 B30 PNG，保留曲绘、定数、成绩、Rating 和来源标签。 |
| 导出 B30 + 候选20 图片 | 5 列共 50 槽 PNG，前 30 为 B30，后 20 为候选；候选不参与 B30 平均值。 |
| 导出 B30 JSON | `b30.json`，按 OTO 格式保存 `data.base_rating_list`。 |
| 导出 B30 + 候选20 JSON | `b30-candidates20.json`，另用 `next_rating_list` 保存排名 31–50。 |

JSON 仅导出已有记录，含 `song_id`、曲名、难度和分数，可从大饼 JSON 入口重新导入；不包含账号、Token 或 Cookie。重新导入时按入口标记来源，并按当前曲库重算 Rating。曲绘加载失败时 PNG 使用占位图。**这些 JSON 不是全部本地成绩与个人别名的完整备份。**

## 本地数据、安全与备份

| 位置 | 保存内容 | 清理行为 |
| --- | --- | --- |
| 浏览器 `localStorage` 的 `chunithm-mate-b30:v2` | 全部综合成绩、来源、个人别名；旧版 v1 自动迁移。 | “清空全部本地数据”删除当前访问地址的成绩和别名，不解除后台绑定。 |
| `.machun.local/` | 登录会话、绑定身份、落雪 Token、大饼成绩缓存与同步位置。 | “解绑”删除对应来源会话/Token/缓存，保留网页中已合并成绩。 |
| `.env` | 可选的自动登录邮箱、用户名和密码。 | 不因网页清空或解绑而删除，需自行管理。 |

后台目录权限设为 `0700`，绑定记录为 `0600`，凭据未另行加密。正式模式只公开 `dist/`，开发模式屏蔽凭据及会话文件；后台仅返回规范化成绩和统计，不返回 Cookie、Token 或原始账号存档。这些本地敏感文件已由 `.gitignore` 排除。

完整成绩备份可在浏览器开发者工具的 Application / Storage → Local Storage 中，保存上述 v2 键的完整值。恢复时使用同一访问地址，将保存的 JSON 写回该键后刷新；先保存原值，避免覆盖现有成绩。B30 JSON 只能补回已导出的部分成绩。个人成绩备份和门户导出的原始存档不要提交到公开仓库。

不要将 `.env` 或 `.machun.local/` 当作成绩备份分享；换机器后重新绑定即可。正在同步时先等待操作结束再解绑；网页登录等待期间可取消绑定。

## 项目结构

```text
src/
  App.tsx                      页面与成绩状态管理
  components/                  来源控制、成绩表格和歌曲详情卡
  core/                        Rating、B30、导入、合并、筛选、存储与导出
  data/catalog.json            13.0+ 评分曲库及内置别名
  data/song-chart-details.json  详情卡补充谱面定数
  types.ts                     曲库和本地成绩类型
  syncTypes.ts                 前后端共享同步类型
server/
  index.ts / http.ts            本机服务、API 和静态资源
  manager.ts / store.ts         绑定、同步调度与本地会话保存
  credentials.ts / portalLogin.ts 自动登录与门户登录入口
  providers/                   四个成绩来源的接口适配
scripts/                       曲库维护和隔离浏览器检查
.env.example                   无凭据的自动登录模板
```

## 曲库与别名维护

曲库和远程曲绘地址参考 [OTOGE DB](https://github.com/zvuc/otoge-db)。分类取上游 `catname`，版本取歌曲级 `version`，`AIR+` 等统一显示为 `AIR PLUS`。上游未知 BPM 用 `null` 表示，不影响成绩匹配与 Rating。

下载上游 `music-ex.json` 和需要的别名 JSON 后，在项目根目录运行对应脚本。脚本会修改内置数据，提交前检查差异：

```bash
# 重新生成全部 13.0+ 评分曲库；会重写 catalog.json
node scripts/build-catalog.mjs /path/to/music-ex.json /path/to/lxns-alias-list.json

# 为已有曲库追加截至指定日期的 13.0–13.9 谱面，保留已有记录
node scripts/expand-catalog.mjs /path/to/music-ex.json /path/to/lxns-alias-list.json 2026-09-17

# 只补充分类/版本，或 BPM/Note 数据
node scripts/enrich-catalog-metadata.mjs /path/to/music-ex.json
node scripts/enrich-catalog-notes.mjs /path/to/music-ex.json

# 更新歌曲详情中不在评分曲库内的 EXP/MAS/ULT 定数
node scripts/build-song-chart-details.mjs /path/to/music-ex.json 2026-09-17

# 合并别名，保留既有别名
node scripts/merge-aliases.mjs /path/to/alias-list.json
```

`build-catalog.mjs` 不限制发布日期；需要维持当前快照时，使用已按日期筛选的输入。`expand-catalog.mjs` 和详情补充脚本默认截止日期为 `2026-09-17`。改变快照日期时还需同步维护 `src/core/catalog.ts` 中的版本信息。

别名来自[落雪公开列表](https://maimai.lxns.net/docs/api/chunithm)及 [ChunithmUtil 社区快照](https://github.com/AmethystTim/ChunithmUtil/blob/abdddd70decc18540dc9fd8f21d37ab5fcfe8954/data/alias.json)，不是 MuNET 别名的完整镜像。合并脚本支持落雪 `aliases` 和社区 `songs[].cid / aliases` 格式；数字编号按 ID 匹配，旧版正式曲名仅在规范化后唯一精确匹配时合并。别名按 Unicode 规范化去重，同一歌曲的所有谱面共享，个人别名独立保存在浏览器。

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

Vitest 覆盖 Rating、成绩解析与合并、来源适配、历史分页、会话及本地接口等行为。另有使用模拟门户和临时浏览器目录的检查脚本：

```bash
# 需先构建；使用模拟后台，不绑定个人账号
pnpm exec tsx scripts/smoke-ui.ts
pnpm exec tsx scripts/smoke-sessions.ts
pnpm exec tsx scripts/smoke-auto-login.ts
```

**当前检查状态：** 最近的表格、详情卡和柱状图改动未重新运行测试或构建。部分组件测试及 `smoke-ui.ts` 仍包含旧的复制曲名、居中布局和中点断言，需要按当前行为更新后再作为验收依据。模拟检查也不能代替四个来源的真实账号验收。

## 常见问题与边界

- **端口已占用**：在先前启动服务的终端按 Ctrl+C，再启动需要的模式；`start` 与 `dev` 都占用 4399。
- **网页有成绩，但同步服务无法连接**：启动 `pnpm start`，或开发模式下确认网页和 API 两个进程都在运行。`preview` 应访问 4400。
- **重启后看不到成绩**：确认浏览器、主机名和端口与原来一致，且未清理站点数据；成绩不保存在后台账号文件中。
- **浏览器无法启动**：执行 `pnpm browser:install`，并确认有可用桌面环境。已安装 Google Chrome 可作为后备。
- **会话过期或卡片改变**：点击重新登录/重新绑定；Rin 使用绑定时选中的卡，大饼要求主卡一致。
- **HTTP 418、限流或门户格式变化**：可能需要在专用浏览器重新登录或等待；不要连续重复同步。当前同步失败不会修改已有成绩，但外部接口变化仍可能需要更新适配代码。
- **导入有未知谱面**：只支持内置 13.0+ EXP/MAS/ULT；BAS、ADV、WORLD’S END 和库外歌曲不会导入。详情卡中的低定数仅供展示。
- **PNG 没有部分曲绘**：远程图片可能不可用，程序使用占位图，不影响成绩和 Rating。

本工具没有多用户权限、云端存储、全量本地备份按钮、自动/定时同步或 QQ Bot。四个门户接口可能变化；首次大饼历史同步仅能读取门户尚存的数据。

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
git add README.md src server scripts package.json pnpm-lock.yaml
git diff --cached --stat
git commit -m "feat: 更新成绩管理功能"
git push
```

按实际修改选择文件，并确认暂存区不包含账号文件、个人成绩备份或导入的原始存档。若推送提示远程有新的提交，先 `git fetch origin` 并检查差异，再合并或变基；不要使用强制推送覆盖远程提交。

## 许可证与非官方声明

项目源代码沿用仓库已有的 [Apache License 2.0](LICENSE)。外部曲库、别名、曲绘、歌曲和其他素材不因此统一适用该许可证，应遵守各自来源的许可与权利声明。

本工具与 SEGA CORPORATION 及上述成绩服务无隶属关系。CHUNITHM 和相关商标、曲绘、歌曲及其他素材归各自权利人所有。曲绘使用 OTOGE DB 的公开远程地址，仓库不保存图片文件。
