# 开发与安装

## 环境

- Node ≥ 24.22.3（dsh 0.2.3-alpha.2 源码的要求）。本机用 Homebrew 的 `node@24`（keg-only，不进默认 PATH），开发前先：

  ```sh
  export PATH=/opt/homebrew/opt/node@24/bin:$PATH
  ```

- pnpm 11（与 dsh 源码一致的 11.28.5，由 node@24 自带的 corepack 提供）：

  ```sh
  corepack enable && corepack prepare pnpm@11.28.5 --activate
  ```

- dsh 源码：`/Users/tiger/workspace/DeepSeek/Harness/deepseek-harness`（`4b399c39a6`，tag `dsh-v0.2.3-alpha.2`）。拉了新代码后在那里重跑 `pnpm install && pnpm run build`。

## 构建与检查

```sh
pnpm install
pnpm build    # lib/index.js（后台一半）和 lib/client.js（前端一半）
pnpm check    # typecheck → build → test
```

## 在开发版 dsh 里跑

用单独的 `DSH_HOME`，不碰桌面版的 `~/.dsh`。`--patch` 不会应用本包自带的 `cordis.patch.yml`，所以 `dev/overlay.cordis.yml` 用绝对路径重复了那几行，并给了开发用的数据目录 `/Users/tiger/Projects/AgentOutpost-data/dev`。

```sh
pnpm build
cd /Users/tiger/workspace/DeepSeek/Harness/deepseek-harness
DSH_HOME=$HOME/.dsh-outpost pnpm dsh web --patch /Users/tiger/Projects/AgentOutpost/dev/overlay.cordis.yml
```

终端会打印带 `?token=` 的地址并打开浏览器（加 `--no-open` 不打开）。侧栏出现「前哨」（望远镜图标），点开显示「前哨」标题。改了代码要先 `pnpm build` 再重启这条命令。

检查后台接口：

```sh
# 不带登录：401（路由在，宿主要求认证）
curl --noproxy '*' -i http://127.0.0.1:3080/outpost/api/health
# 用启动地址里的 token 换登录 Cookie 后：200 {"ok":true}
curl --noproxy '*' -c /tmp/outpost.cookies "http://127.0.0.1:3080/?token=<token>"
curl --noproxy '*' -b /tmp/outpost.cookies http://127.0.0.1:3080/outpost/api/health
```

本机全局走代理，访问 localhost 的 curl 必须加 `--noproxy '*'`。

## 装进桌面版

```sh
dsh plugin add ~/Projects/AgentOutpost
```

然后在 profile 的 `cordis.patch.yml` 里给 `outpost` 这一行配 `dataDir`（绝对路径，本机用 `/Users/tiger/Projects/AgentOutpost-data`），重启后侧栏出现「前哨」：

```yaml
- id: outpost
  config:
    dataDir: /Users/tiger/Projects/AgentOutpost-data
```
