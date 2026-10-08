# 1Panel 部署（Linux amd64）

本分支为单人使用。镜像包含 Node.js、Chromium、虚拟显示和 noVNC，登录在网页内手动完成；不会保存或填写门户密码。服务以 UID 1000 的 `node` 用户运行。

## 1. 构建或取得镜像

本机安装 Docker 后执行：

```bash
pnpm docker:package
```

输出：

- `release/machun1-manual-login-amd64.tar.gz`：`docker image save` 生成并经 gzip 压缩的镜像归档，架构为 `linux/amd64`。
- 同名 `.sha256`：归档 SHA-256 校验值。

它不是源码压缩包，也不是整个 1Panel 应用商店安装包。镜像标签为 `machun1:manual-login-amd64`。构建上下文排除 `.env*`、`.machun.local/`、个人导出和 Git 历史，镜像不含原机器的账号或会话。

## 2. 上传和导入

1. 在 1Panel 的“主机 → 文件”上传镜像归档和校验文件到服务器同一目录。
2. 在终端切换到该目录，执行 `sha256sum -c machun1-manual-login-amd64.tar.gz.sha256`。
3. 打开“容器 → 镜像 → 导入”，选择服务器上的 `machun1-manual-login-amd64.tar.gz`，等待导入完成。
4. 确认镜像列表出现 `machun1:manual-login-amd64`。

1Panel 的镜像导入对应 [Docker load](https://docs.fit2cloud.com/1panel/user-manual/containers/image/)，[Docker 原生支持 gzip 压缩的镜像归档](https://docs.docker.com/reference/cli/docker/image/load/)。面板版本若不允许选择 `.gz`，可在其终端直接执行：

```bash
docker load -i machun1-manual-login-amd64.tar.gz
```

只使用上面的镜像导入，不要将文件解压到网站根目录。

## 3. 创建容器编排

在 1Panel“容器 → 编排”中新建编排，粘贴项目的 `compose.yaml`。配置环境变量：

| 变量 | 示例与含义 |
| --- | --- |
| `MACHUN_PUBLIC_ORIGIN` | `https://chuni.example.com`，必须是最终浏览器访问地址，不带子路径；非标准端口也要填写。 |
| `MACHUN_ACCESS_PASSWORD` | 自行设置至少 12 位随机密码。浏览器访问账号固定为 `machun`。 |
| `MACHUN_PUBLISH_PORT` | 默认 `4399`，服务器端代理入口端口。 |

可以在编排目录放置 `.env`，内容参考项目 `.env.example`，并设置 `chmod 600 .env`。如果该版本的 1Panel 不读取编排目录 `.env`，将编排中的 `environment` 两个值和 `ports` 端口替换为实际配置；不要将配置提交到 Git。

启动后：

- 容器监听 `4399`，默认映射为服务器 `127.0.0.1:4399`。
- 登录桌面的 5900/6080 仅在容器内部监听，不添加端口映射。
- 共享内存为 `1gb`，供 Chromium 使用；建议给服务器至少 2 GB 可用内存，历史同步期间避免同时运行多项高负载任务。
- `machun_data` 命名卷挂载到 `/data`，保留绑定、Token 和大饼同步位置。普通容器更新不会删除卷。
- 健康检查 `/healthz` 只返回运行状态，不包含绑定信息；稍等后容器应显示 healthy。

## 4. 反向代理

在 1Panel 创建反向代理网站，代理到应用的 4399 端口。网站使用根路径部署，启用 HTTPS、WebSocket 转发，并保留浏览器原始 Host。

如果 OpenResty 运行在容器中，`127.0.0.1` 可能指代理容器自身。应将两个容器连接到同一 Docker 网络，再使用 `http://machun1:4399` 作为上游；或按当前 1Panel 的网络配置使用服务器可达的上游地址。无需将登录桌面端口公开。

对应 Nginx location 的关键配置：

```nginx
location / {
    proxy_pass http://machun1:4399;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

实际 `proxy_pass` 按代理所在网络填写。分数同步可能等待门户限流，代理读取超时需要足够长；进度由页面独立轮询。页面访问时输入账号 `machun` 和部署访问密码。不要在这里填写 BCN 或 MuNET 密码。

如果希望在可信内网直接通过 `http://服务器IP:4399` 访问，可将编排端口改为 `"4399:4399"`，并将 `MACHUN_PUBLIC_ORIGIN` 设置为该完整地址。公网上优先使用上述 HTTPS 入口。

## 5. 手动绑定与同步

点击来源“绑定账号”，在弹出的网页登录窗口手动选择登录入口、填写账号和完成验证码。窗口左侧 noVNC 工具栏支持手机键盘、剪贴板输入和缩放设置。浏览器窗口可滚动；手机画面太小时关闭缩放后移动查看。

绑定成功后自动关闭窗口，回到成绩页面。“返回成绩页面”仅暂时收起，可以再次打开；“取消绑定”会终止等待并删除新建会话。同一时间只能打开一个来源的登录窗口，等待上限 5 分钟。落雪使用个人 Token，无需打开浏览器窗口。

之后每次手动点击该来源的“同步成绩”，优先复用会话。会话失效、账号或主卡变化时重新绑定。服务器来源登录仍可能遇到验证码、IP 限制或门户接口变化，需在自己的服务器上逐一验收。

## 6. 数据、更新和停止

成绩和个人别名仍保存在当前浏览器的 `localStorage`，不是 Docker 卷中的统一云端成绩。换手机或访问域名后可以重新同步来源，其他设备不会自动获得手动改分。完整浏览器成绩备份方法见主 README。

更新时重新导入同标签镜像并重建容器，保持原编排项目和 `machun_data` 卷。不要删除卷或执行 `docker compose down -v`，除非确实要清除所有绑定；也不要将该卷或 `.env` 上传到公开位置。

```bash
docker compose up -d --force-recreate
docker compose logs --tail 30
docker compose stop
```

使用主机目录替代命名卷时，预先创建目录并赋予 UID 1000 权限，例如 `chown 1000:1000 /opt/machun1/data && chmod 700 /opt/machun1/data`。已有本机浏览器会话不随镜像迁移，部署后重新绑定。

常见错误：

- `不允许的访问地址`：检查实际访问域名、端口、`MACHUN_PUBLIC_ORIGIN` 和代理 Host 是否一致。
- 登录窗口无法连接：检查代理已启用 WebSocket，容器 healthy；不要映射或直接访问 6080。
- `部署模式必须配置…`：补齐访问地址与至少 12 位访问密码。
- 数据目录无法写入：确认卷或主机目录由 UID 1000 可写。
