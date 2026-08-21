# Install DeepSeek Harness on ZimaOS

English | [中文](zimaos-raw.zh.md)

This tutorial installs the self-contained Linux amd64 `deepseek_harness.raw` extension, configures a DeepSeek API key, and verifies the Web interface on port 3080. The image contains Node.js and the production runtime; installation does not download npm packages.

## Prerequisites

You need a Linux amd64 ZimaOS device reachable over SSH, root access, and a trusted LAN or firewall rule that limits TCP port 3080. Build from a clean DeepSeek Harness checkout with Node.js 24, pnpm 11, `squashfs-tools`, and `xz-utils`, or download both files from the rolling [`latest` Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/latest):

```text
deepseek_harness.raw
deepseek_harness.raw.sha256
```

> [!WARNING] Port 3080 exposes the Harness UI and its shell, filesystem, credential, and agent capabilities. This package adds no CasaOS Gateway route or authentication layer. Before installation starts the service, place the device on a trusted LAN or block untrusted access to port 3080 with a firewall. An authenticated reverse proxy is safe only when the firewall also permits direct port 3080 access solely from that proxy or the local host.

## 1. Obtain and verify the image

To build the same Linux amd64 image used by CI:

```bash
pnpm install --frozen-lockfile
pnpm run build:zimaos-raw
sha256sum -c deepseek_harness.raw.sha256
```

On macOS, verify a downloaded Release artifact with:

```bash
shasum -a 256 -c deepseek_harness.raw.sha256
```

The build requires Linux x64 for its native build and startup probes. `--skip-runtime-probe` is only for static assembler diagnosis and does not replace the Release build.

## 2. Copy and install the extension

Replace `ZIMAOS_IP` with the device address:

```bash
scp deepseek_harness.raw root@ZIMAOS_IP:/var/lib/extensions/
ssh root@ZIMAOS_IP 'zpkg install /var/lib/extensions/deepseek_harness.raw'
```

Confirm that ZimaOS registered the package and started its service:

```bash
ssh root@ZIMAOS_IP 'zpkg list'
ssh root@ZIMAOS_IP 'systemctl is-active deepseek-harness.service'
```

The second command must print `active`.

## 3. Configure credentials and host access

The extension mount below `/usr` is read-only. Store configuration and runtime state in `/var/lib/casaos/deepseek_harness`; the service reads its optional `.env` file at startup.

Create the file with owner-only permissions:

```bash
ssh root@ZIMAOS_IP 'install -d -m 0700 /var/lib/casaos/deepseek_harness && install -m 0600 /dev/null /var/lib/casaos/deepseek_harness/.env'
ssh root@ZIMAOS_IP 'printf "%s\n" "DEEPSEEK_API_KEY=replace-me" > /var/lib/casaos/deepseek_harness/.env'
ssh root@ZIMAOS_IP 'systemctl restart deepseek-harness.service'
```

Edit the value on the device instead of placing a real key in shell history. Add optional provider variables supported by your profile to the same file. If you open the UI through a stable DNS alias instead of the device IP, also set:

```dotenv
DSH_ZIMAOS_TRUSTED_HOST=harness.home.example
```

Restart the service after each `.env` change.

## 4. Verify the Web interface

From a machine on the permitted network:

```bash
curl --fail http://ZIMAOS_IP:3080/
```

Open `http://ZIMAOS_IP:3080/` in a browser. The CasaOS module tile opens the same address while preserving the hostname used for CasaOS.

Check service status and recent logs if either request fails:

```bash
ssh root@ZIMAOS_IP 'systemctl status deepseek-harness.service --no-pager'
ssh root@ZIMAOS_IP 'journalctl -u deepseek-harness.service -n 100 --no-pager'
```

A DNS alias rejected with HTTP 403 is not trusted by the browser-connection policy; set `DSH_ZIMAOS_TRUSTED_HOST` to that exact hostname and restart. Missing runtime or native-addon messages indicate an invalid image or unsupported device architecture; reinstall a verified Linux amd64 artifact rather than installing npm packages below `/usr`.

## 5. Update or remove the package

Inspect locally installed and remotely available packages with:

```bash
ssh root@ZIMAOS_IP 'zpkg list'
ssh root@ZIMAOS_IP 'zpkg list-remote'
```

Verify a new RAW and pass it to `zpkg install` as in step 2. State under `/var/lib/casaos/deepseek_harness` remains outside the read-only image. To remove the extension:

```bash
ssh root@ZIMAOS_IP 'zpkg remove deepseek_harness'
```

Review the retained state directory separately before deleting it; package removal must not be treated as credential erasure.

## Mod Store submission metadata

A store entry for Releases published by this repository uses:

```json
{
  "name": "deepseek_harness",
  "title": "DeepSeek Harness",
  "repo": "deepseek-ai/deepseek-harness"
}
```

If a fork publishes the Release assets, replace `repo` with the actual `owner/repo` that owns those assets.
