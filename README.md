# MACHUN1

MACHUN1 是本机运行的 CHUNITHM 成绩工作台。它汇总 MuNET、Rin、OTO（大饼）和国服落雪的成绩，按谱面保留最高分，提供 Rating 分析、曲库筛选和分表导出。

[快速开始](#quick-start) · [成绩来源](#sources) · [工作台预览](#preview) · [使用指南](docs/usage.md)

<a id="quick-start"></a>

## 快速开始

准备 **Node.js 24.x** 和 **pnpm 10.15.0**，在终端安装并启动工作台。

```bash
git clone https://github.com/MAK1MAAaa/MACHUN1.git
cd MACHUN1
pnpm install --frozen-lockfile
pnpm browser:install
pnpm start
```

启动后打开工作台。服务仅监听本机回环地址，按 **Ctrl+C** 停止。[打开本机工作台](http://127.0.0.1:4399/)

<a id="sources"></a>

## 绑定、同步与导入

展开「成绩来源」，绑定后点击「同步成绩」。已有成绩文件可从对应的来源卡片直接导入。

| 来源 | 绑定方式 | 文件导入 |
| --- | --- | --- |
| MuNET | 在专用浏览器登录，出现滑块时手动验证 | 存档 JSON |
| Rin | 使用 BEMANICN 登录，绑定门户的默认 Aime 卡 | 存档 JSON |
| OTO（大饼） | 使用 BEMANICN 登录，绑定当前主卡 | `oto.json` |
| 国服落雪 | 在工作台填写个人 API Token | 成绩 CSV 或个人成绩 JSON |

同步与导入覆盖内置 13.0+ 评分曲库中的 EXP、MAS 和 ULT 谱面，并保留来源提供的 CLEAR、FC、AJ、AJC 等标记。单个导入文件最大 10 MB。[绑定与同步指南](docs/usage.md#sync)

### 可选自动登录

按模板在项目根目录配置本机 `.env` 并重启服务。Rin 和 OTO 共用 `BCN_EMAIL`、`BCN_PASSWORD`，MuNET 使用 `MUNET_USERNAME`、`MUNET_PASSWORD`。请将凭据留在本机。[配置模板](.env.example) · [本机配置](docs/local.md#可选配置)

点击「绑定账号」或「重新登录」时，配置了完整凭据的来源会在专用浏览器里自动填表并尝试提交一次。Rin 和 OTO 的常规 BEMANICN 授权会自动确认，额外权限或条款在弹窗内处理。也可以直接在弹窗手动登录。成功后工作台保存会话，供后续同步复用和续期。

<a id="preview"></a>

## 工作台预览

![MACHUN1 桌面工作台，展示本地数据、成绩来源和 B30 Rating 柱状分析](docs/previews/redesign-desktop.png)

预览使用演示成绩。桌面以表格浏览全部成绩，手机以卡片显示分数、Rating 和达成状态。

<details>
<summary>查看手机工作台</summary>

<img src="docs/previews/redesign-mobile.png" alt="MACHUN1 手机工作台，展示 B30 导出操作和 Rating 图表" width="390">

</details>

## 浏览与导出

- **BEST 30** 展示最佳 30 张谱面的单曲 Rating 和平均 Rating，空位按零计入平均值。
- **全部成绩** 支持按曲名、别名或 ID 搜索，并按谱面条件筛选。打开歌曲详情可查看谱面资料和编辑个人别名。
- **定数表** 可查看指定定数或某等级内的全部定数。封面模式用于浏览曲绘，成绩模式将分数与评级、达成状态分行显示。

| 导出 | 内容 |
| --- | --- |
| B30 / AJ B30 PNG | 最佳 30 张谱面，或仅统计 AJ / AJC 的最佳 30 张 |
| B30 + 候选 20 | 最佳 30 张及后续 20 张，可导出 PNG 或 OTO 格式 JSON |
| B50 PNG | 旧曲 30 张与 MATE 新曲 20 张，分区统计 |
| 定数表 PNG | 按定数与难度分组的封面或成绩表 |
| B30 JSON | OTO 格式的最佳 30 条成绩 |
| 完整备份 JSON | 全部成绩、来源、达成状态和个人别名 |

[查看 Rating、导出与导入规则](docs/usage.md#records)

## 本地数据

首次启动会在 `.machun.local/` 创建 SQLite 数据库。成绩、个人别名、导出昵称和来源会话保存在该数据目录。端口和数据目录可分别通过 `MACHUN_PORT` 与 `MACHUN_DATA_DIR` 设置。

「本地数据」中的完整备份可用于换机和迁移旧版成绩。导入备份会替换当前成绩和个人别名，来源账号需在新环境重新绑定。[本机运行与数据恢复](docs/local.md#restore-data)

## 开发

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动开发环境，网页端口 4399，API 端口 4398 |
| `pnpm test` | 运行逻辑和 SQLite 集成测试 |
| `pnpm build` | 运行 TypeScript 检查并构建前端 |
| `pnpm test:browser` | 使用 Chromium 验证工作台和模拟门户流程 |

前端使用 React、TypeScript 和 Vite，服务端使用 Node.js 内置 SQLite。[开发与曲库维护](docs/usage.md#development) · [曲库数据来源](src/data/catalog-sources.json)

## 许可证与素材

项目代码采用 [Apache License 2.0](LICENSE)。MACHUN1 与 SEGA CORPORATION 及上述成绩服务无隶属关系。CHUNITHM 商标、曲绘、歌曲及外部数据归各自权利人所有。[素材与数据说明](docs/usage.md#许可证与素材)
