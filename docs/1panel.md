# 1Panel：MySQL 多用户与本机登录助手

当前分支 `codex/manual-login-docker`，镜像 `machun1:companion-20261008-amd64`，架构 linux/amd64。容器以 UID 1000 运行 Node 服务和按需无界面 Chromium，无 VNC、远程桌面代理或固定 Basic Auth。网页登录使用 MySQL 中已有用户，不提供注册。

本轮交付只生成镜像归档，未替换腾讯服务器容器，也未执行正式库新增迁移。现有 408 条成绩在正式 MySQL 中，镜像不包含这些数据或凭据。

## 1. 导入镜像

上传 `release/machun1-companion-20261008-amd64-1650.tar.gz` 与同名 `.sha256`。可以在 1Panel“容器 → 镜像 → 导入”选择归档，也可以执行：

```bash
sha256sum -c machun1-companion-20261008-amd64-1650.tar.gz.sha256
docker load -i machun1-companion-20261008-amd64-1650.tar.gz
```

若面板版本只接受 tar，先 `gzip -dk`，再导入 tar。旧 `machun1-manual-login-amd64-1650.tar.gz` 保留用于回溯，不覆盖。

## 2. 部署前显式迁移数据库

正式 `machun1` 已有 `0001_accounts` 的表和 CRUD 应用账号。本版本还需要 `db/migrations/0002_source_binding_tasks.sql`。由数据库管理连接执行该 SQL；不要授予应用账号建表权限。迁移幂等，不删除成绩，不修改已有用户密码，`users` 仍只有 `username` / `pwd` 两列。

本项目已有 `pnpm db:setup` 会通过 `ssh tencent` 的 MySQL 管理连接顺序执行全部 SQL；这是显式管理操作，应用启动不会自动执行。本轮未运行该命令。其他环境由管理连接按文件名顺序执行迁移。首次新建库需执行 `0001`、`0002`，并显式创建用户及 CRUD 账号；不要将数据库 root 连接放入应用配置。

## 3. 创建容器编排

在 1Panel“容器 → 编排”粘贴根目录 `compose.yaml`。项目使用服务器已确认的外部网络 `1panel-network`；MySQL 容器也必须在该网络内。

在编排目录创建 `.env` 并 `chmod 600 .env`：

```dotenv
MACHUN_PUBLIC_ORIGIN=https://chuni.example.com
DATABASE_URL=mysql://machun_app:填写已有专用密码@1Panel-mysql-3Wrt:3306/machun1
```

`MACHUN_PUBLIC_ORIGIN` 为最终 HTTPS 浏览器地址，不带子路径；非标准端口必须包含。`DATABASE_URL` 使用容器名与容器内 3306，不是本机开发 SSH 隧道的 13306。密码含特殊字符时按 URL 编码。不要提交或分享 `.env`。

若该面板版本不读取目录 `.env`，在编排 `environment` 中填写实际配置。镜像和宿主机入口均为 **1650**，默认只映射 `127.0.0.1:1650:1650`。不要映射 5900 / 6080。`machun_data` 卷挂载 `/data`，保留旧兼容目录；更新镜像不删除卷。共享内存 `1gb`，建议至少 2 GB 可用内存。

## 4. HTTPS 反代

1Panel 网站配置最终域名和有效证书，反代到 `http://127.0.0.1:1650`。保留最终浏览器请求的 Host，例如 `Host: chuni.example.com`，与 `MACHUN_PUBLIC_ORIGIN` 一致。若反代也在容器中，使用同网络服务名 `http://machun1:1650`，仍保留外部 Host。无需 WebSocket 设置。

网页登录 Cookie 为 HttpOnly / SameSite=Lax / Secure，7 天有效。HTTP 服务端口用于反代和健康检查，浏览器实际访问使用 HTTPS。服务校验 Host 和 Origin，不提供跨域 API。`/healthz` 仅返回 `{"status":"ok"}`；它表示应用进程运行，不保证数据库或门户可用。稍等应显示 healthy。

删除旧 `MACHUN_ACCESS_PASSWORD` 和 `MACHUN_REMOTE_LOGIN` 配置。该分支不读取门户账号密码；`main` 保留本机自动填入能力。已有网页账号 `root` 的密码在旧方案中初始化为 `pwd`；本轮不会重置，请在公开使用前通过管理连接设置新的 UTF-8 SHA-256 小写十六进制哈希。

## 5. 电脑绑定、手机同步

电脑安装 Node.js 24 和 pnpm 10.15，检出当前分支与镜像匹配的提交：

```bash
pnpm install
pnpm browser:install
```

无需电脑 MySQL 配置或门户 `.env`。网页登录 → 来源工具 → 绑定账号 / 重新登录 → 生成绑定任务，复制助手命令：

```bash
pnpm login:remote --server https://chuni.example.com --task <网页任务ID>
```

在终端隐藏输入提示后粘贴网页绑定码。助手打开独立官方门户窗口，手动登录并完成验证码。Rin / 大饼通过各自门户的 BCN 入口；MuNET 使用用户名密码和滑块。Rin 必须有唯一默认卡，大饼绑定当前主卡；工具不修改门户主卡。

成功后自动回传必要 Token / localStorage 字段，服务器再核对身份。排除门户密码、BCN Cookie、完整浏览器目录；电脑临时目录结束后清理。落雪继续在网页保存个人 Token。

绑定码 10 分钟有效、仅提交一次，数据库只保存其哈希。取消、重新生成、退出、网页会话失效或服务重启会使未完成任务作废。命令不包含绑定码，助手不跟随重定向、不接受公网 HTTP、不关闭 TLS 证书校验。网络响应丢失可重新运行同一命令查询结果。

日常同步由服务器无界面 Chromium 完成，电脑可以离线。会话过期且无法续期时再运行助手。新会话按用户和来源保存在 MySQL；续期更新快照，容器重启无需电脑重新登录。旧目录不在服务器时显示需重新绑定，保留旧绑定信息和已合并成绩。同账号同卡重绑保留大饼历史位置，换账号 / 卡清除该来源缓存。验证失败不会替换旧绑定。

## 6. 更新与备份

更新前备份 MySQL 和 `/data`，记录当前镜像标签。完整成绩备份仅含成绩、个人别名和达成标记，不含门户凭据；数据库备份包含会话和 Token，必须私密存储。导入新镜像、完成所需显式迁移，再更新编排 image 标签并重建容器，不删除命名卷。

此分支保持桌面网页 B30 3×10（移动端响应式收窄），导出为 5×6 或包含候选20的 5×10。登录、曲库、成绩、别名、来源绑定、Token 与历史位置按用户隔离。

## 故障处理

- 无法启动：检查 HTTPS origin、专用数据库账号、外部网络及容器日志；不要在工单中粘贴 `.env` 或原始浏览器报错。
- API 403：检查反代是否保留最终 Host，Origin 是否与配置一致，端口是否遗漏。
- MySQL 不可用：检查数据库网络、CRUD 权限和两份迁移；页面保留现有数据，不静默退回浏览器存储。
- 登录助手无法连接：先确认 HTTPS 证书有效、完整域名可从电脑访问，任务未过期。不要添加忽略证书选项。
- 身份不匹配：用绑定的账号与卡重新登录；旧成绩保留。
- 会话过期 / MuNET 滑块：在电脑重新生成任务完成官方登录，不需要 VNC。
- 大饼限流：遵循页面等待提示；失败不推进历史位置。先完成一项同步再开启其他高负载操作。
