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

装的是打包出来的 `.tgz`，不是源码目录。桌面版的 profile 在 `~/.dsh/profiles/desktop/`，只能用桌面版自带的 `dsh` 命令管理（npm 装的 `dsh` 拒绝动 `desktop` 这个 profile），而且要在桌面版完全退出时做。下面的 `DSH` 就是那条命令：

```sh
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
```

1. **确认桌面版空闲，再退出。** 没有会话在跑、没有排队的消息、前哨的运行记录里没有「运行中」（前哨自己的日更也算）。然后 ⌘Q 正常退出；它若弹「退出 DeepSeek Harness？」说有任务会被中断，先取消，等任务跑完再退。
2. **备份桌面版 profile 的两个文件**（`cordis.patch.yml` 还不存在就只备份 `package.json`）：

   ```sh
   BACKUP=~/Projects/AgentOutpost-data/backup/$(date +%Y%m%d-%H%M%S)
   mkdir -p "$BACKUP"
   cp ~/.dsh/profiles/desktop/package.json "$BACKUP"/
   cp ~/.dsh/profiles/desktop/cordis.patch.yml "$BACKUP"/
   ```

3. **检查并打包**，得到 `dsh-outpost-<version>.tgz`（版本号取自 `package.json`）：

   ```sh
   cd /Users/tiger/Projects/AgentOutpost
   export PATH=/opt/homebrew/opt/node@24/bin:$PATH
   pnpm check && pnpm pack
   ```

4. **装进桌面版 profile**，确认列表里有 `dsh-outpost`：

   ```sh
   "$DSH" plugin --profile desktop add /Users/tiger/Projects/AgentOutpost/dsh-outpost-<version>.tgz
   "$DSH" plugin --profile desktop list
   ```

   报 `incompatible-version` 说明桌面版不是 0.2.3-alpha.2 系列（`package.json` 的 `engines.dsh` 是 `>=0.2.3-alpha.2 <0.3.0`），先停下来对版本，不要用版本豁免硬装。

5. **给前哨配数据目录。** 包里自带的 `cordis.patch.yml` 插入的那一行 id 是 `outpost`（包名才是 `dsh-outpost`），它不带 `dataDir`，前哨没有它就不启动。在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾追加（保留原有内容）：

   ```yaml
   - id: outpost
     config:
       dataDir: /Users/tiger/Projects/AgentOutpost-data
   ```

   这是正式数据目录；开发版 dsh 用的是 `/Users/tiger/Projects/AgentOutpost-data/dev`，两个不要混用（同一个目录同时只能被一个前哨打开）。

6. **（可选）开浏览器兜底**，让公众号、小红书、知乎这类有验证页的原文也能打开核实。包里带了两行，默认关着：`outpost-browser-use`（`@deepseek-ai/dsh-browser-use`）和 `outpost-browser-use-playwright`（`@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`，`mode: launch`、`headless: true`）。**一个 profile 只能注册一个浏览器提供方**，多了 dsh 会拒绝第二个。所以先看桌面版里是不是已经开了别的浏览器提供方：「插件」页里有没有已启用的 browser-use 行（别的插件也可能带），以及 profile 补丁里有没有：

   ```sh
   grep -n "browser-use" ~/.dsh/profiles/desktop/cordis.patch.yml
   ```

   - 已经有别的提供方（连同它的 `dsh-browser-use` 行）开着：前哨这两行保持关闭，前哨会直接用已注册的那个。
   - 没有：把这两行一起打开。在桌面版「插件」页打开这两个开关，或者在 `cordis.patch.yml` 末尾追加：

     ```yaml
     - id: outpost-browser-use
       disabled: false
     - id: outpost-browser-use-playwright
       disabled: false
     ```

     Playwright 要用 Chromium 内核的浏览器。它自己找不到时，给这一行指定本机的 Chrome（`config` 要写全）：

     ```yaml
     - id: outpost-browser-use-playwright
       disabled: false
       config:
         mode: launch
         headless: true
         executablePath: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
     ```

7. **重新打开桌面版。** 侧栏出现「前哨」（望远镜图标），设置页显示的数据目录是 `/Users/tiger/Projects/AgentOutpost-data`；开了浏览器兜底的话，设置页「浏览器兜底」一栏显示「浏览器兜底已开启」，不再提示去「插件」页启用。

**撤回**：退出桌面版，`"$DSH" plugin --profile desktop remove dsh-outpost`，再把备份的 `package.json`、`cordis.patch.yml` 拷回 `~/.dsh/profiles/desktop/`。数据目录里的东西不会被删。
