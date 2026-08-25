# Agent Note: ZimaOS RAW 分发

Status: implemented

[English](2026-08-20-zimaos-raw-distribution.md) | 中文

## 问题

DeepSeek Harness 过去没有可安装的 ZimaOS 系统扩展。ZimaOS RAW 镜像必须提供 systemd 与 CasaOS 元数据，以及完全位于 `/usr` 下的可执行运行时；可变状态则必须留在只读扩展挂载之外。

Web profile 需要 Node.js 24、生产依赖闭包、已构建的宿主 bundle 和浏览器资源。依赖设备提供 Node.js，或在设备上安装 npm 包，会使安装依赖网络，并可能运行未经测试的版本。复制 monorepo 的部分目录则会把 workspace link 与动态资源留在产物之外。

CasaOS 模块宿主与 `dsh web` 不同源。浏览器客户端使用同源的 `/api` HTTP 与 WebSocket 路径，因此在没有 Gateway 路由时，把 Web dist 的静态副本放入 `/usr/share/casaos/www/modules` 会连接到错误的服务器。

## 决定

仓库组装一个名为 `deepseek_harness.raw` 的 Linux amd64 SquashFS 镜像。包标识为 `deepseek_harness`，服务为 `deepseek-harness.service`，官方 CLI 入口为 `/usr/bin/dsh`，不可变应用根目录为 `/usr/lib/deepseek-harness`。`zimaos/raw/usr` 下的源骨架拥有 systemd unit、extension-release 元数据、CasaOS 模块元数据、启动页、图标与 ZimaOS 专用 Cordis overlay。

镜像内置 Linux x64 的 Node.js `v24.19.0`。`scripts/build-zimaos-raw.ts` 下载归档和官方 `SHASUMS256.txt`，验证对应归档的精确 digest，并且只缓存以 digest 为键且已经验证的归档。`zimaos/runtime/package.json` 独立于 Python SDK runtime，拥有 Web 生产闭包，并显式安装关闭 pnpm 自动 peer 安装后会被省略的必需 workspace peer provider。共享 runtime-closure verifier 会遍历 app、package 与 vendored manifest，并拒绝完整 ZimaOS dependency graph 中缺失的必需 peer。组装器以仓库 lockfile 运行 pnpm legacy deploy，并遵守 `pnpm-workspace.yaml` 中按软件包审查的 `allowBuilds`；构建子进程会删除名称表示凭据的环境变量。组装器实体化链接，补入 deploy 遗漏的 vendored `cosmokit` 与 `schemastery` runtime 包，删除开发依赖元数据，并以原子替换方式重写剩余 workspace range，避免 pnpm hardlink 修改源码 manifest。静态验证会拒绝应用目录中的符号链接、暂存闭包中缺失的必需生产依赖、残留的 `workspace:` range、缺失的动态资源，以及 ELF machine 不是 Linux x64 的原生产物。Landlock 软件包 verifier 还会拒绝占位文件与未声明二进制。

RAW 将 `/usr/bin/dsh` 暴露为内置 Node.js 与官方 CLI 的透明包装，因此交互命令使用正常入口，包括 `dsh web`。systemd 服务设置 `HOME=/media/ZimaOS-HD`，读取可选的 `/media/ZimaOS-HD/.dsh/.env`，并运行只附加 ZimaOS overlay 与 `--no-open` 的 `dsh web`。`ProtectSystem=full` 将 `/usr`、`/boot` 与 `/etc` 保持为只读，同时允许写入 `/media` 等 ZimaOS 数据挂载；`PrivateTmp=true` 提供隔离的临时存储。组装器通过 `DSH_ZIMAOS_STAGED_ROOT` 让同一个包装器指向暂存根目录，以供 Linux CI 探测。overlay 完整重述 `webserver` 行以选择 `host: 0.0.0.0`，完整重述 connection 行，在保留 `webRuntime.trustedHosts` 的同时启用显式的 `allowRemoteManagement`，并完整重述 `web-runtime` 行以附加可选的 `DSH_ZIMAOS_TRUSTED_HOST`；公共 CLI 仍拒绝 `--host 0.0.0.0`。

该服务不注册 CasaOS Gateway 路由，也不依赖 CasaOS message bus。CasaOS 模块提供禁用缓存的启动页，保留当前主机名并导航到 `http://<host>:3080/`。完整前端仍由 `dsh web` 提供，从而保持 `/api` 请求与 WebSocket upgrade 同源。connection Host 会把对应的管理能力注入启动 HTML，因此远程 Client settings scope 使用 Host 存储，而不是不可用的 memory 模式。在任何 Client 插件激活之前，如果 HTTP 局域网来源不提供 `crypto.randomUUID()`，Web 启动入口会通过 `crypto.getRandomValues()` 提供 UUID v4 生成能力。

组装器验证标识与必需路径，使用内置 Node.js 运行暂存后的 CLI，并在 Linux x64 上启动暂存启动器、探测 Web shell 与 `/api/host.describe`、通过 `DSH_ZIMAOS_TRUSTED_HOST` 配置的 authority 调用 `settings.describe`、通过不可信 Host authority 拒绝同一管理请求，并要求有界停止。它将暂存 inode 时间规范化为 `SOURCE_DATE_EPOCH` 或源码 commit 时间，并以固定创建时间、root 所有权、`-noappend` 与 `-no-xattrs` 创建 SquashFS；在 `unsquashfs` 可用时检查镜像必需路径，并在镜像旁写入 SHA-256 文件。构建输出只保存在已忽略的构建位置。GitHub Actions 保留经过校验的构建产物供 job 间传递，将成功的同仓库 PR（Pull Request）构建作为直接资产发布到滚动更新的 `zimaos-raw-preview` 预发布版本，并且只从最新成功的 `dsh-v*` 标签推进非预发布的 `latest` Release。两个滚动发布 job 都通过 Release database id 暂存和替换资产，因为 GitHub 会在已发布 Release 转为 draft 时解除它与稳定标签的关联。job 会恢复中断上传所留下的唯一匹配 `untagged-*` draft，在恢复候选不唯一时失败，校验 draft 资产，以 lease 移动稳定标签，并在发布 Release 时恢复 `tag_name`。来自 fork 的 pull request 无法获得替换预览资产所需的仓库写权限。

## 考虑过的替代方案

**通过 CasaOS Gateway 注册 `/api`。** 不采用，因为本分发明确使用直接局域网监听，不增加 CasaOS 管理平面集成。如果软件包必须在不可信局域网上安全运行，重新引入 Gateway 认证是前置条件。

**从 CasaOS 模块目录提供完整前端。** 不采用，因为客户端会相对页面 origin 解析 `/api` 与 WebSocket。没有 Gateway 注册或新的跨源传输配置时，静态副本无法正确连接 `dsh web`。

**使用设备的 Node.js，或在安装期间安装 npm 依赖。** 不采用，因为 ZimaOS 不保证经过测试的 Node.js 版本或网络可用性，而只读 RAW 包必须已经包含可执行运行时。

**编译单个 Node.js SEA 可执行文件。** 不采用，因为动态包加载、原生依赖、profile 配置和浏览器资源仍需要暂存文件树。SEA 会增加专用打包逻辑，却无法消除必须验证的运行时闭包。

**同时发布 amd64 与 arm64 镜像。** 暂缓，因为首个选定目标是 amd64。当 arm64 设备成为受支持的验证目标时，文件名与发布自动化可以增加架构后缀与矩阵。

## 后果

组装完成后，产物是自包含的，应用目录不再依赖构建 checkout。定向测试钉住包标识、缺失路径、符号链接拒绝、不会写穿 hardlink 的 manifest 重写、未解析生产依赖拒绝、启动器组合、直连端口行为与共享 deploy 行为。一项无 key 的 assembled-client snapshot 会让没有 Host 能力的非 loopback 页面保持不可用，然后验证同一页面获得该能力后可以打开 Host-backed 的 Models 设置。Linux 运行时探测要求 `settings.describe` RPC 成功，并且响应 id 和设置描述字段符合预期；HTTP 2xx 包装的业务错误不能通过。如果检入的 Linux 启动器仍是非 ELF 占位文件，静态组装会在打包前失败；Linux x64 必须先构建并验证该启动器，再创建镜像。deploy 探测会使源码 package manifest 保持字节一致。Linux x64 仍是内置原生产物与 Web 启动探测的权威环境。

绑定 `0.0.0.0:3080` 会把 Harness UI 及其 shell、文件系统、设置、凭据与 agent 能力直接暴露给可达网络。该软件包不增加 CasaOS 认证层；操作者必须使用可信网络、防火墙或带认证的反向代理。

内置 Node.js 与原生依赖树会增加镜像体积，并可能依赖 ZimaOS 的 glibc 与内核基线。CI 启动探测可以验证 Linux amd64 行为，但不能替代在真实 ZimaOS 设备上的安装。Mod Store 发布与实机验收仍是独立的后续工作；本地组装器不声称这些表面已经存在。

RAW 挂载为只读。任何尝试写入安装文件旁边的插件或依赖都会失败；可变状态应位于 `/media` 下，默认 Harness home 为 `/media/ZimaOS-HD/.dsh`。
