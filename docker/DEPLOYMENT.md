# MACHUN1 一体部署包

适用于当前 1Panel 的 Linux amd64 服务器，已包含镜像、编排及启动脚本。

## 上传后使用

在 1Panel 文件管理中上传并解压 `@PACKAGE_FILENAME@`，打开所在目录的终端，运行：

```bash
sudo bash @PACKAGE_DIRECTORY@/start.sh
```

若已进入解压出的目录，运行 `sudo bash start.sh` 即可。脚本会校验文件、导入随包镜像、启动编排、等待健康检查，并只读验证 MySQL；不需要安装 pnpm 或填写 `.env`。

启动后访问 `http://服务器公网IP:1650`，网页登录为 `root / pwd`。MySQL 连接为 `machun_app / 123456`，与网页登录密码不同。

## 当前服务器预设

使用已有 `1panel-network` 和 `1Panel-mysql-3Wrt:3306/machun1`。正式库需已有两项迁移和 root 用户；本包不会创建空库、修改数据库密码或重置成绩。端口为 `1650:1650`，安全组需允许 TCP 1650。

如旧容器已占用 1650，先在 1Panel 停止旧容器，再运行脚本；脚本不会停止其他项目。编排项目名固定为 `machun1`，重复执行用于更新该项目，保留命名卷，不删除旧卷。

外层压缩包用于文件管理上传及解压；如需单独在“镜像 → 导入”操作，选择解压后的 `@IMAGE_FILENAME@`，然后在“编排”使用随包的 `compose.yaml`。上传或仅导入镜像不会自动执行编排。

## 停止

在解压出的目录执行：

```bash
sudo docker compose -p machun1 -f compose.yaml stop
```

HTTP 会明文传输网页登录及助手会话。编排包含你指定的数据库连接密码，仅用于自己的服务器；镜像不含数据库凭据。
