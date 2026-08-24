# 在 ZimaOS 上安装 DeepSeek Harness

[English](zimaos-raw.md) | 中文

本教程安装自包含的 Linux amd64 `deepseek_harness.raw` 扩展，配置 DeepSeek API key，并验证 3080 端口上的 Web 界面。镜像已经包含 Node.js 与生产运行时，安装过程不会下载 npm 包。

## 前提条件

你需要一台可通过 SSH 访问的 Linux amd64 ZimaOS 设备、root 权限，以及一个限制 TCP 3080 端口访问范围的可信局域网或防火墙规则。你可以在干净的 DeepSeek Harness checkout 中使用 Node.js 24、pnpm 11、`musl-tools`、`squashfs-tools` 与 `xz-utils` 构建，也可以从滚动更新的 [`latest` Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/latest) 下载以下两个文件：

```text
deepseek_harness.raw
deepseek_harness.raw.sha256
```

[`zimaos-raw-preview` 预发布版本](https://github.com/deepseek-ai/deepseek-harness/releases/tag/zimaos-raw-preview) 会直接提供最新一次同仓库 PR（Pull Request）成功构建的相同两个文件。预览文件可能随时被覆盖；需要带标签的构建时请使用 `latest`。

> [!WARNING] 3080 端口会暴露 Harness UI 及其 shell、文件系统、设置、凭据与 agent 能力。ZimaOS overlay 会显式启用远程 Host 管理，因此每个能够访问获准 authority 的客户端都可以查看或替换 provider 设置与 API key。本软件包不增加 CasaOS Gateway 路由或认证层。在安装启动服务之前，请将设备放在可信局域网内，或用防火墙阻止不可信来源访问 3080 端口。只有防火墙同时将 3080 端口的直连来源限制为该反向代理或本机时，带认证的反向代理才不会被绕过。

## 1. 获取并校验镜像

构建与 CI 相同的 Linux amd64 镜像：

```bash
pnpm install --frozen-lockfile
pnpm run build:zimaos-raw
sha256sum -c deepseek_harness.raw.sha256
```

在 macOS 上使用以下命令校验从 Release 下载的产物：

```bash
shasum -a 256 -c deepseek_harness.raw.sha256
```

原生构建与启动探测要求 Linux x64。`--skip-runtime-probe` 只用于组装器静态诊断，不能代替 Release 构建。

## 2. 复制并安装扩展

将 `ZIMAOS_IP` 替换为设备地址：

```bash
scp deepseek_harness.raw root@ZIMAOS_IP:/var/lib/extensions/
ssh root@ZIMAOS_IP 'zpkg install /var/lib/extensions/deepseek_harness.raw'
```

确认 ZimaOS 已注册软件包并启动服务。镜像也会暴露官方 CLI 入口，因此 SSH 用户可以直接运行 `dsh web` 及其他 `dsh` 命令；服务使用附加 ZimaOS 网络 overlay 与 `--no-open` 的 `dsh web`。

验证安装：

```bash
ssh root@ZIMAOS_IP 'zpkg list'
ssh root@ZIMAOS_IP 'systemctl is-active deepseek-harness.service'
```

第二条命令必须输出 `active`。

## 3. 配置凭据与主机访问

`/usr` 下的扩展挂载是只读的。服务默认将配置与运行状态存放在 `/media/ZimaOS-HD/.dsh`，并在启动时读取其中可选的 `.env` 文件。

Web UI 可以直接配置 provider 与凭据，无需 SSH。以下可选文件仍适合预配或由环境持有的凭据；创建该文件并将权限限制为仅属主可读写：

```bash
ssh root@ZIMAOS_IP 'install -d -m 0700 /media/ZimaOS-HD/.dsh && install -m 0600 /dev/null /media/ZimaOS-HD/.dsh/.env'
ssh root@ZIMAOS_IP 'printf "%s\n" "DEEPSEEK_API_KEY=replace-me" > /media/ZimaOS-HD/.dsh/.env'
ssh root@ZIMAOS_IP 'systemctl restart deepseek-harness.service'
```

请在设备上编辑该值，不要把真实 key 写入 shell 历史。可以将 profile 支持的可选 provider 变量加入同一文件。如果你通过稳定 DNS 别名而不是设备 IP 打开 UI，还要设置：

```dotenv
DSH_ZIMAOS_TRUSTED_HOST=harness.home.example
```

每次修改 `.env` 后都要重启服务。

## 4. 验证 Web 界面

在获准访问的网络中的另一台机器上运行：

```bash
curl --fail http://ZIMAOS_IP:3080/
```

在浏览器中打开 `http://ZIMAOS_IP:3080/`；如果 `.env` 没有提供凭据，请从“设置”中配置 provider。CasaOS 模块入口会打开同一地址，并保留访问 CasaOS 时使用的主机名。即使浏览器未提供仅限安全上下文的 `crypto.randomUUID()`，Web 客户端也支持这个普通 HTTP 局域网来源。

如果任一请求失败，请检查服务状态与近期日志：

```bash
ssh root@ZIMAOS_IP 'systemctl status deepseek-harness.service --no-pager'
ssh root@ZIMAOS_IP 'journalctl -u deepseek-harness.service -n 100 --no-pager'
```

如果 DNS 别名被 HTTP 403 拒绝，说明浏览器连接策略尚未信任该名称；将 `DSH_ZIMAOS_TRUSTED_HOST` 设置为这个精确主机名并重启服务。缺失运行时或原生 addon 的消息表示镜像无效或设备架构不受支持；应重新安装经过校验的 Linux amd64 产物，而不是在 `/usr` 下安装 npm 包。

## 5. 更新或移除软件包

查看本地安装的软件包与远程可用软件包：

```bash
ssh root@ZIMAOS_IP 'zpkg list'
ssh root@ZIMAOS_IP 'zpkg list-remote'
```

校验新的 RAW 后，按照步骤 2 将其传给 `zpkg install`。`/media/ZimaOS-HD/.dsh` 下的状态独立于只读镜像。移除扩展：

```bash
ssh root@ZIMAOS_IP 'zpkg remove deepseek_harness'
```

删除保留的状态目录前请单独检查；不能把移除软件包视为已经擦除凭据。

## Mod Store 提交元数据

由本仓库发布 Release 时，商店条目使用：

```json
{
  "name": "deepseek_harness",
  "title": "DeepSeek Harness",
  "repo": "deepseek-ai/deepseek-harness"
}
```

如果 Release 资产由 fork 发布，请将 `repo` 替换为实际拥有这些资产的 `owner/repo`。
