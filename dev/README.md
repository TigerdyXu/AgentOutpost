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
2. **备份桌面版 profile 的几个文件**（`pnpm-lock.yaml` 会被安装改写，一起备份；哪个文件还不存在就跳过它）：

   ```sh
   BACKUP=~/Projects/AgentOutpost-data/backup/$(date +%Y%m%d-%H%M%S)
   mkdir -p "$BACKUP" && chmod 700 "$BACKUP"
   for f in package.json cordis.patch.yml cordis.yml pnpm-lock.yaml; do
     [ -f ~/.dsh/profiles/desktop/$f ] && cp -p ~/.dsh/profiles/desktop/$f "$BACKUP"/
   done
   chmod 600 "$BACKUP"/*
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

6. **浏览器兜底（默认打开，只给前哨的调研会话用）。** 公众号、小红书、知乎这类有验证页的原文，靠它用无界面 Chrome 打开核实。它装在包里的 `outpost-researcher` 预设里（`browser` 那一组：`@deepseek-ai/dsh-browser-use` 服务和 `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` 提供方，`mode: launch`、`headless: true`、`executablePath` 指向本机 Chrome），所以只有前哨的调研会话有浏览器，你自己的会话没有。

   - **两个包必须装进 profile**：桌面版 0.2.3-alpha.2 不自带它们，没装的话调研预设起不来，前哨的推荐、建档、核查、日更**全都跑不了**。同样要在桌面版退出时装（会从 npm 下载 `@playwright/mcp` 等约 10 个包，不下载 Chromium；提示「declares no dsh.bundle — installed as a plain dependency」是正常的）：

     ```sh
     "$DSH" plugin --profile desktop add @deepseek-ai/dsh-browser-use@0.2.3-alpha.2 @deepseek-ai/dsh-experimental-browser-use-playwright-mcp@0.2.3-alpha.2
     ```

   - **profile 里不要再开整个 profile 共用的 Playwright 提供方**：两边同时开着，调研会话会建不起来（`serverName "playwright-mcp" is already in use`）。M1 时包里那两行 `outpost-browser-use`、`outpost-browser-use-playwright` 已经去掉；profile 补丁里针对这两个 id 的覆盖行（M1 验收后加的 `disabled: true`）删掉即可。先看一眼：

     ```sh
     grep -n "browser-use" ~/.dsh/profiles/desktop/cordis.patch.yml
     ```

   - **代价**（2026-11-26 开发环境实测）：每个活着的调研会话带一个 Playwright MCP 进程（约 125 MB），打开过网页的再带一个无界面 Chrome（空白页约 0.7 GB，真实网页更多）。前哨在每次调研结束时结束这个会话的实时状态，两样随之关掉，所以只有正在跑的调研会话占着；之后你在 dsh 里点开某个已结束的调研会话看，它会重新起一个 Playwright 进程，直到桌面版重启。调研会话有整组 `browser_*` 工具，其中 `browser_run_code_unsafe` 按 Playwright 自己的说明等同远程代码执行，调用不经确认，而调研会话读的是不可信网页。
   - **关掉或换浏览器**：在 profile 补丁里覆盖 `outpost-researcher-preset` 这一行。覆盖会整段替换 `config`，所以要把包里 `cordis.patch.yml` 的这一行整段抄过来，去掉 `browser` 那一组（关掉），或改 `executablePath`（换成别的 Chromium 内核浏览器；删掉这一行则让 Playwright 自己找）。关掉后打不开的原文按「待确认」处理。

7. **（按需）指定研究用的模型。** 前哨默认用桌面版的默认模型。如果默认模型不是 DeepSeek（比如设成了本机 Ollama），联网搜索和花费估算都对不上，给 `outpost` 行加上：

   ```yaml
   - id: outpost
     config:
       dataDir: /Users/tiger/Projects/AgentOutpost-data
       model:
         provider: deepseek-official
         model: deepseek-flash
   ```

   也可以在前哨的设置页「模型」一栏填。

8. **重新打开桌面版。** 侧栏出现「前哨」（望远镜图标；界面语言跟随系统，英文系统下叫「Outpost」），设置页显示的数据目录是 `/Users/tiger/Projects/AgentOutpost-data`；两个浏览器包装好了的话，设置页「浏览器兜底」一栏显示「浏览器兜底已开启」。

**撤回**：退出桌面版，`"$DSH" plugin --profile desktop remove dsh-outpost`（连同 `@deepseek-ai/dsh-browser-use`、`@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` 一起 remove），再把备份的 `package.json`、`cordis.patch.yml`（以及 `pnpm-lock.yaml`）拷回 `~/.dsh/profiles/desktop/`。数据目录里的东西不会被删。

**装新版本**：重新 `pnpm check && pnpm pack`，退出桌面版，然后**先 remove 再 add**（版本号没变时，直接再 `add` 同一个 `.tgz` 会提示「Already up to date」而不换文件）：

```sh
"$DSH" plugin --profile desktop remove dsh-outpost
"$DSH" plugin --profile desktop add /Users/tiger/Projects/AgentOutpost/dsh-outpost-<version>.tgz
```

再打开桌面版。前哨在设置页里改的值写在 `cordis.patch.yml` 的 `outpost` 行里，remove 不会动它。
