# MACHUN1 工作区设计系统

从当前应用提取的浅绿界面基础，用于延续已有视觉。重点是清晰的分数、谱面信息和操作状态，不重新设计品牌。

## 查看

- [组件展示](ui-kit-workspace/index.html)：面板、按钮、字段、达成标签和成绩行。
- [颜色与字体 token](tokens/colors_and_type.css)
- [文案规则](brand/voice-and-tone.md)
- [视觉规则](brand/style-notes.md)
- [可复用技能](SKILL.md)

展示只包含公开曲库信息和明确标注的示例分数，没有真实账号或成绩。HTML 自包含，无 CDN、外部字体、网络请求或 React 安装要求；旁边的 JSX 文件是组件结构参考。

## 来源

提取日期：2026-10-13。

- `src/styles.css`：`:root`、实际生效的浅绿主题覆盖、面板、字段、难度和成绩行。
- `src/mobile.css`：16 px 输入字号、44 px 操作触摸目标和小屏边界。
- `src/components/AccountApp.css`、`AccountApp.tsx`：登录面板和账号操作。
- `src/components/RecordsSection.css`、`RecordsSection.tsx`：浏览方式、筛选、表格和分页。
- `src/components/ScoreBadges.css`、`ScoreBadges.tsx`：评级、FC、AJ、AJC 与 FCHAIN 标签。
- `src/core/scoreAchievements.ts`：达成名称与含义。
- `src/data/catalog.json`：公开歌曲标题、编号、定数、分类与版本。

源码前段仍包含被后续浅绿主题覆盖的旧深色值；本系统提取最终生效的浅色值。没有独立品牌图标或本地字体资源，因此没有复制或新增图标、字体资产。

这是当前应用的提取快照；本轮移动端布局改进以应用最终实现为准，可在后续同步到组件展示。
