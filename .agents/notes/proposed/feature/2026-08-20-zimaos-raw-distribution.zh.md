# Agent Note: ZimaOS RAW 分发

Status: proposed

[English](2026-08-20-zimaos-raw-distribution.md) | 中文

## 问题

DeepSeek Harness 目前没有可安装的 ZimaOS 系统扩展。ZimaOS RAW 镜像必须提供 systemd unit、系统扩展元数据、CasaOS 模块元数据，以及完全位于 `/usr` 下的可执行运行时；所有可变状态则必须位于只读扩展挂载之外。

Web profile 需要 Node.js 24、生产依赖闭包、已构建的宿主 bundle 和浏览器资源。依赖 ZimaOS 提供 Node.js，或在设备上安装 npm 包，会使安装依赖网络，并可能运行仓库未测试的版本。直接复制 monorepo 或选定的 `lib/` 目录也会让 workspace link 与动态资源落在产物之外。

CasaOS 模块宿主与 `dsh web` 不同源。浏览器客户端使用同源的 `/api` HTTP 与 WebSocket 路径，因此在不注册 Gateway 路由的情况下，把完整 Web dist 放入 `/usr/share/casaos/www/modules` 会连接到错误的服务器。本分发方案明确不注册 CasaOS Gateway，而是在固定局域网端口开放 Web profile。

## 提案

仓库发布一个名为 `deepseek_harness.raw` 的 Linux amd64 RAW 镜像。包标识为 `deepseek_harness`，服务为 `deepseek-harness.service`，可执行文件为 `/usr/bin/deepseek-harness`，不可变应用根目录为 `/usr/lib/deepseek-harness`。静态检查会拒绝 extension-release 文件、模块 JSON、服务声明、启动器与输出文件名之间不一致的拼写。

镜像携带一个在版本控制构建配置中选定的精确 Node.js 24 Linux x64 版本，并通过 Node.js 发布的 SHA-256 清单验证。应用目录是从完整构建后的 workspace 生成并实体化的生产依赖闭包，不包含 workspace 符号链接；它在普通的内置 Node.js 下运行，不依赖 tsx、源码路径、调用方的 `node_modules` 或暂存根目录之外的文件。

systemd 服务设置 `DSH_HOME=/var/lib/casaos/deepseek_harness`，读取可选的 `/var/lib/casaos/deepseek_harness/.env`，并在进程失败后重启。启动器创建可写状态目录，然后以 `dsh web --patch /usr/lib/deepseek-harness/zimaos.patch.yml --port 3080 --no-open` 执行暂存后的 CLI。受版本控制的 overlay 只把 `webserver` 行设为 `host: 0.0.0.0`；公共 CLI 仍拒绝 `--host 0.0.0.0`，避免其他部署意外暴露远程代码执行能力。该服务不注册 CasaOS Gateway 路由，也不依赖 CasaOS message bus。

CasaOS 模块目录包含图标和一个禁用缓存的轻量启动页。该页面从当前位置取得 ZimaOS 主机名，并把新标签页导航到 `http://<host>:3080/`。完整的 DeepSeek Harness 前端仍由 `dsh web` 拥有和提供，从而保持 `/api` 请求与 WebSocket upgrade 同源。

仓库脚本在临时根目录中组装 RAW 镜像。它构建官方生产产物、实体化运行时闭包、下载并验证 Node.js、复制受版本控制的 RAW 骨架、验证 JSON 与必需路径、使用内置 Node.js 运行暂存后的 CLI、在 Linux 上启动暂存后的 Web profile、探测 HTML 与 `/api` 路径，最后以 `-noappend -no-xattrs` 调用 `mksquashfs`。构建输出不会提交到 Git。

GitHub Actions 在 PR（Pull Request）和普通 `master` push 上运行组装与探测，并把 `deepseek_harness.raw` 上传为 workflow 产物。`dsh-v*` tag 还会把轻量 `latest` tag 移到本次构建的 commit，并创建或更新 GitHub `latest` Release。该 Release 既不是 draft，也不是 prerelease，并使用同一 workflow 探测通过的字节替换已有 RAW asset。

## 考虑过的替代方案

**通过 CasaOS Gateway 注册 `/api`。** 不采用，因为本分发方案明确使用直接局域网监听，不增加 CasaOS 管理平面集成。模块启动页改为打开后端提供的前端。

**从 CasaOS 模块目录提供完整前端。** 不采用，因为现有客户端会相对页面 origin 解析 `/api` 及其 WebSocket。没有 Gateway 注册或新的跨源传输配置时，静态副本无法正确连接 `dsh web`。

**使用设备的 Node.js，或在安装期间安装 npm 依赖。** 不采用，因为 ZimaOS 不保证经过测试的 Node.js 版本或网络可用性，而只读 RAW 包必须已经包含可执行运行时。

**编译单个 Node.js SEA 可执行文件。** 不采用，因为动态包加载、原生依赖、profile 配置和浏览器资源仍需要暂存文件树。SEA 会增加专用打包逻辑，却无法消除必须验证的运行时闭包。

**同时发布 amd64 与 arm64 镜像。** 首个版本不采用，因为选定的 ZimaOS 目标是 amd64。当 arm64 设备成为受支持的验证目标时，文件名和 workflow 可以增加架构后缀与矩阵。

## 验收标准

- `deepseek_harness.raw` 在已批准路径中包含 `ID=_any`、模块 manifest、启动器、systemd 服务、图标、启动页、内置 Node.js 与实体化的生产应用目录。
- 组装后的启动器只使用 RAW 镜像内的文件及 `/var/lib/casaos/deepseek_harness`；干净的 Linux amd64 探测可在没有系统 Node.js 的情况下，把 `dsh web` 启动于 `0.0.0.0:3080`。
- CasaOS 启动页保留当前主机名，并打开 3080 端口上由后端提供的前端；任何构建或运行步骤都不注册 CasaOS Gateway 路由。
- 组装流程会拒绝错误校验和、缺少动态运行时文件、残留 workspace 符号链接、不一致的包标识、格式错误的模块 JSON、缺少 systemd 目标或失败的 Web/API 探测。
- PR 构建并验证镜像但不发布。`dsh-v*` tag 更新一个公开、非 draft、非 prerelease 的 `latest` Release，并只替换其中的 `deepseek_harness.raw` asset。
- 贡献者文档说明本地构建命令、使用绝对路径的 ZimaOS 安装命令、服务检查、可写状态位置、直连端口安全策略与 Mod Store 配置字段。

## 风险

绑定 `0.0.0.0:3080` 会把 Harness UI 及其 shell、文件系统、凭据与 agent 能力直接暴露给可达网络。本提案不增加 CasaOS 认证层；操作者必须把网络视为可信，或提供外部防火墙或带认证的反向代理。如果软件包需要在不可信局域网上安全运行，重新引入 Gateway 认证是前置条件。

内置 Node.js 与原生依赖树会增加镜像体积，并可能依赖 ZimaOS 的 glibc 与内核基线。CI 可以证明 Linux amd64 的组装与启动，但不能替代在真实 ZimaOS 设备上的安装；因此发布验证包含文档规定的 `zpkg install`、`systemctl`、HTTP 与日志探测。

滚动的 `latest` Release 优先满足 Mod Store 发现，而不是不可变 Release URL。带版本的源码 tag 仍保留审计轨迹；需要可复现字节的消费方必须记录所选 workflow run 的 asset 校验和。

RAW 挂载为只读。即使 session 与 settings 状态使用 `DSH_HOME`，任何尝试写入安装文件旁边的插件或依赖仍会失败；暂存运行时探测必须从只读应用目录执行启动，后续写路径失败应把相应状态移动到 `/var/lib/casaos/deepseek_harness`，而不是削弱扩展目录布局。
