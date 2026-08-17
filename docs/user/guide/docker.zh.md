# 使用 Docker 部署

[English](docker.md) | 中文

本指南介绍如何把从仓库源码构建的 DeepSeek Harness Web UI 作为容器部署,并涵盖已发布的镜像、持久化数据、CLI 入口与网络暴露。它假设已安装带 compose 插件的 Docker,并从[根 README 的 Docker 一节](../../../README.md#run-in-docker)开始。

## 运行 Web UI

在仓库根目录:

```sh
docker compose up -d
```

然后打开 `http://127.0.0.1:3080`。模型配置与普通的 [Web UI 指南](./index.md)一致:打开**设置 → 模型**,输入 DeepSeek API 密钥并保存。

## 持久化数据与工作区

compose 文件把命名卷挂载到容器的 `~/.dsh`(`/home/node/.dsh`)。harness 把 API 密钥、设置、会话与配置文件都保存在这里,因此镜像升级或容器重建都不会丢失。

项目目录挂载在 `/workspace`,服务器也从这里启动,所以 `/workspace` 是 agent 的默认文件系统位置。修改 bind 的源路径即可让 agent 面向其他目录工作。

服务器会读取工作目录与 `~/.dsh` 下的 `.env`,容器环境变量优先级更高,因此 `DEEPSEEK_API_KEY` 可以经由这三种途径中的任意一种提供。

## 镜像入口

镜像入口是 `dsh` CLI,默认命令以自带的绑定 overlay 启动 Web UI。所有 CLI 模式都通过在入口后追加参数运行;覆盖默认命令的模式在需要容器绑定时必须同时声明 overlay:

```sh
# Headless task
DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" docker run --rm -v "$PWD:/workspace" \
  ghcr.io/ns2kracy/deepseek-harness:latest --profile headless "Summarize this repository"

# Web UI on another port
DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" docker run --rm -p 127.0.0.1:8080:8080 -v "$PWD:/workspace" \
  ghcr.io/ns2kracy/deepseek-harness:latest web --patch /opt/dsh/docker-web.patch.yml --port 8080
```

`dsh plugin --profile <name> <pnpm args>` 在容器内同样可用;镜像自带 pnpm。

## 网络暴露

`web` 命令刻意拒绝通配主机名标志:服务器没有 TLS 或身份认证,因此绑定全部接口是一个刻意的部署姿态,而不是一个标志。容器通过 `/opt/dsh/docker-web.patch.yml` 采取这一姿态:它把 webserver 行设为绑定 `0.0.0.0`,端口仍然跟随 `--port`(默认 3080)。容器网络就是暴露边界。

`/api` 浏览器信任栅栏带来两条推论:

- **宿主机回环(compose 默认)。** `127.0.0.1:3080:3080` 的映射只把端口发布在宿主机回环上,请求携带的 `Host` 是回环地址,栅栏无需额外标志即放行。
- **局域网暴露。** 把映射改为 `3080:3080`,并声明浏览器访问服务器所用的主机名,例如 `--trusted-host harness.internal` 或 `--trusted-host 192.168.1.5:3080`。不带端口的授权对任意端口生效;`host:port` 形式的授权精确匹配。`Host` 既非回环也未被声明的请求会被拒绝(403)。

## 镜像与标签

[发布工作流](../../../.github/workflows/docker-publish.yml)在每次推送到 `master`、打版本标签以及手动触发时构建 `linux/amd64` 与 `linux/arm64`:

- `ghcr.io/ns2kracy/deepseek-harness` —— 通过 fork 自带的 GitHub token 自动发布。
- Docker Hub 上的 `ns2kracy/deepseek-harness` —— 仅当 fork 配置了 `DOCKERHUB_USERNAME` 与 `DOCKERHUB_TOKEN` secrets 时发布。

每次推送都会发布 `latest`(在 `master` 上)、git ref 名、版本标签对应的语义化版本号,以及 `sha-<commit>` 标签。

如需在本地构建镜像,在仓库根目录运行 `docker build -t dsh .`。
