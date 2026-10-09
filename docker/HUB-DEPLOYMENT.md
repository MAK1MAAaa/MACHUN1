# MACHUN1 Docker Hub 部署包

用于现有 1Panel Linux amd64 服务器，包含预设编排和启动脚本，镜像由脚本从 `mak1maaaa/machun1` 拉取。

在 1Panel 文件管理上传并解压 `@PACKAGE_FILENAME@`，进入解压目录，运行：

```bash
sudo bash start.sh
```

也可从外层目录运行 `sudo bash @PACKAGE_DIRECTORY@/start.sh`。脚本自动校验文件、拉取 Hub 镜像、注入数据库连接、加入 `1panel-network`、映射 `1650:1650`，等待健康检查并只读检查现有数据库。无需填写环境变量、安装 pnpm 或建立 SSH 隧道。

完成后访问 `http://服务器公网IP:1650`，网页登录 `root / pwd`。项目名固定为 `machun1`，使用已有 `/data` 命名卷；再次运行脚本可更新该项目，保留原数据。已有其他容器占用 1650 时，先在面板停止该容器，保留原数据卷。脚本不会停止其他项目。

编排预设连接当前 MySQL 容器 `1Panel-mysql-3Wrt:3306/machun1`，需已有 `1panel-network`、root 用户及两项迁移。脚本不会新建数据库、执行迁移或修改用户密码，连接失败不会报告部署成功。

此包的 `compose.yaml` 包含你的数据库连接密码，只上传到自己的服务器，勿发布到 Docker Hub 或公开仓库。公开镜像不含数据库凭据、个人成绩或门户会话。外部 `.sha256` 用于上传后的校验；内部文件会由脚本自动校验。

如在 1Panel“容器 → 编排”操作，粘贴随包 `compose.yaml`，项目名使用 `machun1` 并选择启动编排。不要仅在“镜像”中拉取后单独创建一个没有环境变量的容器。

停止应用：

```bash
sudo docker compose -p machun1 -f compose.yaml stop
```
