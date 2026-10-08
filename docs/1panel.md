# 1Panel 部署（Linux amd64）

本分支为单人使用。镜像包含 Node.js、Chromium、虚拟显示和 noVNC，登录在网页内手动完成；不会保存或填写门户密码。服务以 UID 1000 的 `node` 用户运行。

## 1. 构建或取得镜像

本机安装 Docker 后执行：

```bash
pnpm docker:package
```

输出：

- `release/machun1-manual-login-amd64-1650.tar.gz`：免配置版本的 gzip 镜像归档，架构为 `linux/amd64`，应用端口为 1650。
- 同名 `.sha256`：归档 SHA-256 校验值。

它不是源码压缩包，也不是整个 1Panel 应用商店安装包。镜像标签为 `machun1:manual-login-amd64`。构建上下文排除 `.env*`、`.machun.local/`、个人导出和 Git 历史，镜像不含原机器的账号或会话。

## 2. 上传和导入

1. 在 1Panel 的“主机 → 文件”上传镜像归档和校验文件到服务器同一目录。
2. 在终端切换到该目录，执行 `sha256sum -c machun1-manual-login-amd64-1650.tar.gz.sha256`。
3. 打开“容器 → 镜像 → 导入”，选择服务器上的 `machun1-manual-login-amd64-1650.tar.gz`，等待导入完成。
4. 确认镜像列表出现 `machun1:manual-login-amd64`。

1Panel 的镜像导入对应 [Docker load](https://docs.fit2cloud.com/1panel/user-manual/containers/image/)，[Docker 原生支持 gzip 压缩的镜像归档](https://docs.docker.com/reference/cli/docker/image/load/)。面板版本若不允许选择 `.gz`，可在其终端直接执行：

```bash
docker load -i machun1-manual-login-amd64-1650.tar.gz
```

只使用上面的镜像导入，不要将文件解压到网站根目录。

## 3. 创建容器编排

在 1Panel“容器 → 编排”中新建编排，粘贴以下内容即可。**无需 `.env`、访问域名或页面账号密码配置。**

```yaml
services:
  machun1:
    image: machun1:manual-login-amd64
    platform: linux/amd64
    restart: unless-stopped
    shm_size: 1gb
    ports:
      - "1650:1650"
    volumes:
      - machun_data:/data

volumes:
  machun_data:
```

启动后直接打开 `http://服务器IP:1650`。首次从 1Panel 的链接打开也可正常访问；后台按当前请求地址检查同源 API 和 WebSocket，不需要预先填写域名。服务器防火墙需允许本人使用的网络访问 1650。

启动后：

- 容器监听 `1650`，宿主机端口也为 `1650`，映射到所有网卡。
- 登录桌面的 5900/6080 仅在容器内部监听，不添加端口映射。
- 共享内存为 `1gb`，供 Chromium 使用；建议给服务器至少 2 GB 可用内存，历史同步期间避免同时运行多项高负载任务。
- 成绩和个人别名仅保存在当前浏览器的 `localStorage`，不同浏览器的数据独立。
- `machun_data` 命名卷挂载到 `/data`，只保存来源绑定、会话、Token 和大饼同步缓存。普通容器更新不会删除卷；同一实例共用这些来源绑定。
- 健康检查 `/healthz` 只返回运行状态，不包含绑定信息；稍等后容器应显示 healthy。

已部署旧版时，重新导入镜像后，将原编排替换为以上内容并重建容器，删除原来的 `environment` 访问地址／密码设置，保持原编排项目和数据卷。只更换镜像不会自动删除旧容器的环境变量。

## 4. 可选反向代理

直接访问 IP:1650 即可；需要使用域名或 HTTPS 时，再在 1Panel 创建反向代理网站。网站使用根路径部署，代理到应用的 1650 端口，启用 WebSocket 转发，并保留浏览器原始 Host。无需配置 `MACHUN_PUBLIC_ORIGIN`。

如果 OpenResty 运行在容器中，`127.0.0.1` 可能指代理容器自身。应将两个容器连接到同一 Docker 网络，再使用 `http://machun1:1650` 作为上游；或按当前 1Panel 的网络配置使用服务器可达的上游地址。无需将登录桌面端口公开。

对应 Nginx location 的关键配置：

```nginx
location / {
    proxy_pass http://machun1:1650;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

实际 `proxy_pass` 按代理所在网络填写。分数同步可能等待门户限流，代理读取超时需要足够长；进度由页面独立轮询。本版本没有页面访问密码，能访问该实例的人可以操作同一套来源绑定。

## 5. 手动绑定与同步

点击来源“绑定账号”，在弹出的网页登录窗口手动选择登录入口、填写账号和完成验证码。窗口左侧 noVNC 工具栏支持手机键盘、剪贴板输入和缩放设置。浏览器窗口可滚动；手机画面太小时关闭缩放后移动查看。

绑定成功后自动关闭窗口，回到成绩页面。“返回成绩页面”仅暂时收起，可以再次打开；“取消绑定”会终止等待并删除新建会话。同一时间只能打开一个来源的登录窗口，等待上限 5 分钟。落雪使用个人 Token，无需打开浏览器窗口。

之后每次手动点击该来源的“同步成绩”，优先复用会话。会话失效、账号或主卡变化时重新绑定。服务器来源登录仍可能遇到验证码、IP 限制或门户接口变化，需在自己的服务器上逐一验收。

## 6. 数据、更新和停止

成绩和个人别名仍保存在当前浏览器的 `localStorage`，不是 Docker 卷中的统一云端成绩。换手机或访问域名后可以重新同步来源，其他设备不会自动获得手动改分。完整浏览器成绩备份方法见主 README。

更新时重新导入同标签镜像并重建容器，保持原编排项目和 `machun_data` 卷。不要删除卷或执行 `docker compose down -v`，除非确实要清除所有绑定；也不要将该卷上传到公开位置。

```bash
docker compose up -d --force-recreate
docker compose logs --tail 30
docker compose stop
```

使用主机目录替代命名卷时，预先创建目录并赋予 UID 1000 权限，例如 `chown 1000:1000 /opt/machun1/data && chmod 700 /opt/machun1/data`。已有本机浏览器会话不随镜像迁移，部署后重新绑定。

常见错误：

- 仍出现页面访问密码：删除旧编排中的 `MACHUN_ACCESS_PASSWORD`、`MACHUN_PUBLIC_ORIGIN` 后重建容器。
- `不允许的访问地址`：检查代理保留原 Host；旧编排中的固定 `MACHUN_PUBLIC_ORIGIN` 会继续限制访问地址。
- 登录窗口无法连接：检查代理已启用 WebSocket，容器 healthy；不要映射或直接访问 6080。
- 数据目录无法写入：确认卷或主机目录由 UID 1000 可写。
