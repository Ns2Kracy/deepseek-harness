# Agent Note: 通过完整工作区镜像进行容器部署

Status: implemented

[English](2026-08-17-docker-deployment.md) | 中文

## 问题

harness 每台机器只有一条部署路径:安装 Node 与 pnpm 后运行 `npx @deepseek-ai/dsh web`,或从源码构建仓库。服务器与 CI runner 没有任何容器制品。容器也无法通过映射端口发布 Web 界面,因为 `web` 命令拒绝通配主机名标志,服务器默认绑定回环(见[绑定地址 note](../feature/2026-07-22-web-bind-address.md))。

## 决策

仓库在根目录提供容器构建:[Dockerfile](../../../../Dockerfile)、[.dockerignore](../../../../.dockerignore)、[compose 文件](../../../../docker-compose.yml)与[绑定 overlay](../../../../docker/docker-web.patch.yml)。[发布工作流](../../../../.github/workflows/docker-publish.yml)在每次推送到 `master`、打版本标签以及手动触发时构建 `linux/amd64` 与 `linux/arm64`,始终推送 `ghcr.io/ns2kracy/deepseek-harness`(使用内置 GitHub token),并仅当 fork 配置了 `DOCKERHUB_USERNAME` 与 `DOCKERHUB_TOKEN` secrets 时推送 Docker Hub 的 `ns2kracy/deepseek-harness`。标签包括 `master` 上的 `latest`、git ref 名、语义化版本号与 `sha-<commit>`。

镜像是原地构建的完整工作区:基于 `node:24-slim`,构建阶段按冻结 lockfile 安装并运行仓库构建,运行时阶段复制整棵树并额外安装 `git`、`curl` 与 `ca-certificates`,以及钉在根 manifest `packageManager` 版本上的全局 `pnpm@11.7.0`(使 `dsh plugin` 从任意工作目录都能找到 pnpm)。入口是 `node /app/apps/cli/lib/bin.js`,进程以 `node` 用户运行、工作目录为 `/workspace`,默认命令是 `web --patch /opt/dsh/docker-web.patch.yml`。该 overlay 即 [web-server 参考](../../../../docs/subsystems/web-server.md)记录的刻意全接口姿态:把 webserver 行的 `host` 替换为 `0.0.0.0`,端口仍跟随 `--port`。`/api` 浏览器信任栅栏继续放行回环 `Host`(compose 默认只把端口发布在宿主机回环上)与已声明的 `--trusted-host` 主机名。

## 曾考虑的替代方案

**用 `pnpm deploy --prod` 生成精简运行时,镜像 npm 发布闭包。** 不予采纳:裁剪后的目录树恰好会在启动最微妙之处——配置文件 bundle 解析、修复后的 `profiles/node_modules` 回退与按包名导入插件——偏离受支持的两种布局(源码检出与 npm 安装),而且 deploy 自带其失败模式,换来的体积收益在当前阶段意义不大。

**在镜像内安装 npm 发布包。** 不予采纳:fork 从自己的源码构建自己的镜像;消费 registry 制品会把可复现性钉在一次发布步骤上,也无法携带未发布的改动。

**为每种界面(web、headless、ACP)分别构建镜像。** 不予采纳:单一入口通过追加参数已经能表达所有模式,分镜像只会复制构建时间与标签管理成本,却没有对应的消费方需求。

## 后果

- 镜像很大:运行时阶段携带完整依赖树,包括 dev 依赖。代价换来与源码检出完全一致的布局,以及开箱即用的 `dsh plugin`。
- 全接口绑定只存在于随镜像发布的 overlay,永远不是一个标志;覆盖默认 `web` 入口的命令必须重新声明 `--patch /opt/dsh/docker-web.patch.yml` 才能通过发布端口访问。
- 局域网暴露是显式的 compose 变更(端口映射加 `--trusted-host`);默认姿态只发布在宿主机回环上。
- Docker Hub 发布通过 fork secrets 选择加入;仅凭 fork 的内置 token 即可完成 GHCR 发布。
- 工作流在每次推送到 `master` 时构建两种架构,但不在拉取请求上构建,因此添加 PR 触发之前,损坏的 Dockerfile 只会在合并后才暴露。
