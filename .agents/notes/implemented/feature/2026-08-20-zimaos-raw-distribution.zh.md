# Agent Note: ZimaOS RAW 分发

Status: implemented

[English](2026-08-20-zimaos-raw-distribution.md) | 中文

## 问题

DeepSeek Harness 过去没有可安装的 ZimaOS 系统扩展。ZimaOS RAW 镜像必须提供 systemd 与 CasaOS 元数据，以及完全位于 `/usr` 下的可执行运行时；可变状态则必须留在只读扩展挂载之外。

Web profile 需要 Node.js 24、生产依赖闭包、已构建的宿主 bundle 和浏览器资源。依赖设备提供 Node.js，或在设备上安装 npm 包，会使安装依赖网络，并可能运行未经测试的版本。复制 monorepo 的部分目录则会把 workspace link 与动态资源留在产物之外。

CasaOS 模块宿主与 `dsh web` 不同源。浏览器客户端使用同源的 `/api` HTTP 与 WebSocket 路径，因此在没有 Gateway 路由时，把 Web dist 的静态副本放入 `/usr/share/casaos/www/modules` 会连接到错误的服务器。

## 决定

仓库组装一个名为 `deepseek_harness.raw` 的 Linux amd64 SquashFS 镜像。包标识为 `deepseek_harness`，服务为 `deepseek-harness.service`，可执行文件为 `/usr/bin/deepseek-harness`，不可变应用根目录为 `/usr/lib/deepseek-harness`。`zimaos/raw/usr` 下的源骨架拥有 systemd unit、extension-release 元数据、CasaOS 模块元数据、启动页、图标与 ZimaOS 专用 Cordis overlay。

镜像内置 Linux x64 的 Node.js `v24.19.0`。`scripts/build-zimaos-raw.ts` 下载归档和官方 `SHASUMS256.txt`，验证对应归档的精确 digest，并且只缓存以 digest 为键且已经验证的归档。`zimaos/runtime/package.json` 独立于 Python SDK runtime，拥有 Web 生产闭包。组装器以仓库 lockfile 运行 pnpm legacy deploy，并遵守 `pnpm-workspace.yaml` 中按软件包审查的 `allowBuilds`；构建子进程会删除名称表示凭据的环境变量。组装器实体化链接，补入 deploy 遗漏的 vendored `cosmokit` 与 `schemastery` runtime 包，删除开发依赖元数据，并以原子替换方式重写剩余 workspace range，避免 pnpm hardlink 修改源码 manifest。静态验证会拒绝应用目录中的符号链接、暂存闭包中缺失的必需生产依赖、残留的 `workspace:` range、缺失的动态资源，以及 ELF machine 不是 Linux x64 的原生产物。Landlock 软件包 verifier 还会拒绝占位文件与未声明二进制。

systemd 服务设置 `DSH_HOME=/var/lib/casaos/deepseek_harness`，读取可选的 `/var/lib/casaos/deepseek_harness/.env`，并在失败后重启。启动器将可选的 `DSH_ZIMAOS_TRUSTED_HOST` 映射为一个正确引用的 `--trusted-host` 参数，创建可写状态目录，随后用内置 Node.js 执行暂存后的 CLI、ZimaOS overlay、3080 端口和 `--no-open`。组装器专用的 `--staged-root` 参数允许 Linux CI 在不挂载镜像的情况下探测同一个启动器。overlay 完整重述 `webserver` 行，并选择 `host: 0.0.0.0`；公共 CLI 仍拒绝 `--host 0.0.0.0`。

该服务不注册 CasaOS Gateway 路由，也不依赖 CasaOS message bus。CasaOS 模块提供禁用缓存的启动页，保留当前主机名并导航到 `http://<host>:3080/`。完整前端仍由 `dsh web` 提供，从而保持 `/api` 请求与 WebSocket upgrade 同源。

组装器验证标识与必需路径，使用内置 Node.js 运行暂存后的 CLI，并在 Linux x64 上启动暂存启动器、探测 Web shell 和 `/api/host.describe`、接受通过 `DSH_ZIMAOS_TRUSTED_HOST` 配置的 authority、拒绝不可信 Host authority，并要求有界停止。它将暂存 inode 时间规范化为 `SOURCE_DATE_EPOCH` 或源码 commit 时间，并以固定创建时间、root 所有权、`-noappend` 与 `-no-xattrs` 创建 SquashFS；在 `unsquashfs` 可用时检查镜像必需路径，并在镜像旁写入 SHA-256 文件。构建输出只保存在已忽略的构建位置。

## 考虑过的替代方案

**通过 CasaOS Gateway 注册 `/api`。** 不采用，因为本分发明确使用直接局域网监听，不增加 CasaOS 管理平面集成。如果软件包必须在不可信局域网上安全运行，重新引入 Gateway 认证是前置条件。

**从 CasaOS 模块目录提供完整前端。** 不采用，因为客户端会相对页面 origin 解析 `/api` 与 WebSocket。没有 Gateway 注册或新的跨源传输配置时，静态副本无法正确连接 `dsh web`。

**使用设备的 Node.js，或在安装期间安装 npm 依赖。** 不采用，因为 ZimaOS 不保证经过测试的 Node.js 版本或网络可用性，而只读 RAW 包必须已经包含可执行运行时。

**编译单个 Node.js SEA 可执行文件。** 不采用，因为动态包加载、原生依赖、profile 配置和浏览器资源仍需要暂存文件树。SEA 会增加专用打包逻辑，却无法消除必须验证的运行时闭包。

**同时发布 amd64 与 arm64 镜像。** 暂缓，因为首个选定目标是 amd64。当 arm64 设备成为受支持的验证目标时，文件名与发布自动化可以增加架构后缀与矩阵。

## 后果

组装完成后，产物是自包含的，应用目录不再依赖构建 checkout。定向测试钉住包标识、缺失路径、符号链接拒绝、不会写穿 hardlink 的 manifest 重写、未解析生产依赖拒绝、启动器组合、直连端口行为与共享 deploy 行为。如果检入的 Linux 启动器仍是非 ELF 占位文件，静态组装会在打包前失败；Linux x64 必须先构建并验证该启动器，再创建镜像。deploy 探测会使源码 package manifest 保持字节一致。Linux x64 仍是内置原生产物与 Web 启动探测的权威环境。

绑定 `0.0.0.0:3080` 会把 Harness UI 及其 shell、文件系统、凭据与 agent 能力直接暴露给可达网络。该软件包不增加 CasaOS 认证层；操作者必须使用可信网络、防火墙或带认证的反向代理。

内置 Node.js 与原生依赖树会增加镜像体积，并可能依赖 ZimaOS 的 glibc 与内核基线。CI 启动探测可以验证 Linux amd64 行为，但不能替代在真实 ZimaOS 设备上的安装。发布 workflow、贡献者安装文档、Mod Store 元数据与实机验收仍是独立的后续工作；本地组装器不声称这些表面已经存在。

RAW 挂载为只读。任何尝试写入安装文件旁边的插件或依赖都会失败；相应状态必须移动到 `/var/lib/casaos/deepseek_harness`，而不是削弱扩展目录布局。
