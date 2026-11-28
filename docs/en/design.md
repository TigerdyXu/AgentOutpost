> English translation of [设计文档.md](../设计文档.md). If the two differ, the Chinese original wins.

# 前哨 (Outpost) Design Document

> A plugin for the DeepSeek Harness (dsh for short) desktop app: pick a track, the AI recommends hot products, you tick the ones you want, and then the Agent researches every day, fact checks the results and updates the dossiers, and gives you a 「今日哨报」 (Today's brief).
>
> Status: **Final** (the user agreed on 2026-11-25 to move on to the implementation plan). The user chose the UI part page by page on 2026-11-25. Items marked "my decision" were decided by Claude and the user may change them. For the implementation plan see [`docs/plans/`](../plans/) (Chinese).
>
> **M1.1 changes (2026-11-26)**: The UI is always Chinese. Models are set for four uses (research, fact check, writing the brief summary, follow-up), and follow-up no longer uses the desktop app's default model. Local models and the Claude subscription count as ¥0 and do not use the daily budget. When deciding whether two products are the same, the name and company are first written in one standard form and then compared. When picking candidates, products already tracked in another track are marked. Brief cards show the name of the track being filtered. The browser fallback is on by default, is given only to Outpost's research sessions, and is closed after each research run. Sentences below that conflicted with these changes have been updated. For details see [`docs/en/m1.1-design.md`](m1.1-design.md).
>
> **M1.2 changes (2026-11-26)**: An existing track can get more products (under each track there is a row 「＋ 添加产品」 (+ Add product), see the end of §5.3). A product can be moved to another track, also added to one, or removed from one (the 「⋯」 (more actions) menu on the product page, see the end of §5.4). For details see [`docs/en/m1.2-design.md`](m1.2-design.md).
>
> **M1.3 changes (2026-11-27)**: Spend is counted in full: web searches are estimated per search, DeepSeek off-peak is priced at half, and 「追问」 (follow-up) chats are counted. For details see [`docs/en/m1.3-design.md`](m1.3-design.md).
>
> **M1.4 changes (2026-11-27)**: Outpost installs and runs with a plain `dsh plugin add`, without the install script: the data directory defaults to `~/.outpost/data`; without the browser plugins, research runs on a preset without a browser, and the settings page says how to install them; the version is now 0.1.4 and changes with each milestone. For details see [`docs/en/m1.4-design.md`](m1.4-design.md).
>
> **M1.5 changes (2026-11-28)**: the interface follows the Desktop's language setting (Chinese or English), including the fixed sentences the background writes and the default dimension names; what the AI writes is unchanged. Tracks and products can be deleted (for good; spending records stay) and edited: a track's name, focus and dimensions, a product's name, company and official site (the ⋯ beside a track's name, and the product page's ⋯). For details see [`docs/en/m1.5-design.md`](m1.5-design.md).
>
> **M1.6 changes (2026-11-28)**: 「官方」 (Official) is the checker's call: a source counts as official, and so as enough on its own, only once the checker, having opened the page, finds that the product's maker published it (the mark the source came in with is only a hint); sources checked before no longer count as official. The brief no longer says "continues tomorrow" for a paused product; the Sources tab lists each page once. For details see [`docs/en/m1.6-design.md`](m1.6-design.md).

## 1. Why build this

The user keeps following product news in directions such as Personal Agent (Meta Muse, 豆包·小豆, OpenAI Dots, Grok Bots, 蚂蚁灵光 and others). Until now they asked an Agent to search each time (for example, on 11-16 in 飞书 (Feishu) they asked dsh-superagent to "check what is new lately among personal agents"). The problems with an ad hoc search: every time it starts from zero, results do not connect, you cannot see "what changed", and it is hard to tell true from false.

What Outpost sets out to be is a **standing intelligence station**: every product has a dossier that keeps being updated, each day it reports only the new changes, every conclusion has a source, and every change leaves a trace.

**Who it is for**: the user personally (not for making reports for a boss). So the priorities are: quick to read, thorough, smooth to use, good-looking. No export of reporting material.

**References**:
- `~/Projects/RepoRadar`: the same shape (profile building + periodic reports of changes), but its subject is GitHub repositories. Its report conventions and its ideas for tracking changes can be borrowed.
- `~/Projects/dsh-superagent/prototype/repo` (upstream commit 6337fc8): a working third-party dsh plugin package. Outpost's engineering skeleton follows it.

## 2. Goals, non-goals, anti-goals

**Goals**
1. Pick a track → the AI recommends candidates (with evidence of popularity and reasons) → you tick → profiles are built automatically.
2. Every day on schedule (default 08:00), do incremental research on each tracked product, update the dossier after fact checking, and produce Today's brief.
3. Product dossiers are organized by "dimension" (defaults: 定位 (positioning), 目标人群 (target users), 价值场景 (value scenarios), 体验 (experience), 关键技术 (key technology), 商业化 (monetization); a track can add custom dimensions, such as 「记忆」 (memory)). Each dimension has conclusions, full text, sources and a change history.
4. The track page can compare products side by side (comparison matrix + positioning map) and can start cross-product 「专题」 (topic) deep dives.
5. Fully embedded in the dsh desktop app, so it looks like part of dsh.

**Non-goals (not in this phase)**
- Multi-user sharing, team collaboration, permissions.
- Export of reporting material (PPT / Word).
- Mobile; system push notifications (the number in the sidebar is the reminder).
- Paywalls, content that needs a login to read.

**Anti-goals (counts as failure even if built)**
- Writing unverified things into a dossier; mixing AI inference with fact.
- Padding to look full. When nothing happened, say nothing happened.
- Quietly changing conclusions without a trace. Every change to a dossier must show "when, because of which source, what changed".
- Runaway cost.

## 3. Constraints

- **dsh version**: the desktop app and the source are both aligned to **0.2.3-alpha.2** (decided by the user on 2026-11-25, upgraded the same day). The desktop app is Electron, and the shell runs the full web app, so the plugin UI is exactly the same on web and desktop. Note: the alpha.2 desktop installer was installed by hand from the official download site. The update channel (nightly) currently only pushes 0.2.2-rc.5, but the updater is set not to downgrade (`apps/desktop/src/updates/electron-updater/channel.ts:12`), so it will not be pulled back to rc.5. dsh is in developer preview and will have incompatible changes. `engines.dsh` is pinned to `^0.2.3-alpha.2`, and after upgrading dsh everything must be regression tested.
- **dsh source**: `/Users/tiger/workspace/DeepSeek/Harness/deepseek-harness`, master at `4b399c39a6` (tag `dsh-v0.2.3-alpha.2`). The dsh paths below are all relative to it. superagent is pinned to `^0.2.1-alpha.2` and `@deepseek-ai/cordis 4.0.5-alpha.1`; when copying its package config, change the version numbers to match alpha.2. When dsh is upgraded later, upgrade the source and the desktop app together.
- **Backup before the upgrade** (2026-11-25): `~/Projects/AgentOutpost-data/backup/` holds the `~/.dsh` from before the upgrade (without the runtime), the desktop app data, and the rc.3 installer (checksum verified). They can be used for a rollback. Note that the `~/.dsh` backup contains `.credentials.yaml`.
- **The desktop app must be open to run**: dsh schedules only work while the host is running. If the laptop lid was closed and the 08:00 run was missed, run that day's job once the next time the app is opened (see §7.6).
- **Network**: all outbound traffic on this machine goes through the proxy `127.0.0.1:7897`. When the dsh host starts, it installs an undici dispatcher with proxy policy as the global default (`packages/util/http-proxy/src/install.ts:234-238`), so a plugin inside the host process that uses Node's `fetch` directly also goes through the proxy. `ctx.web.fetch` accepts only html / text / json / xml (`packages/web/web-fetch-http/src/policy.ts:78-84`), so **binary files such as downloaded icons need Node `fetch`**; use `ctx.web.fetch` to read page text. (Corrected after review)
- **Search**: dsh ships with only one search provider, DeepSeek. On the deepseek route it uses DeepSeek Messages search (not billed per call); in other cases it uses the DeepSeek Search API; fetching pages uses HTTP fetch (the "Provider availability" section of `docs/subsystems/web.md`). `packages/web/web-search-exa` and `web-search-perplexity` are empty directories and do not really exist. Browser automation (`ctx.browserUse`, Playwright MCP and others, `docs/subsystems/browser-use.md`) is an experimental feature. Desktop 0.2.3-alpha.2 does not ship the two packages for it (`@deepseek-ai/dsh-browser-use` and `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`), so they must first be installed into the profile with the desktop app's `dsh plugin --profile desktop add` (verified in practice during the 2026-11-26 acceptance; the steps are in [`dev/README.md`](../../dev/README.md) (Chinese)). M1 fact checking needs it. Since M1.1 it is written into Outpost's own `outpost-researcher` preset and is on by default. Only Outpost's research sessions have a browser; your own sessions do not. After each research run, Outpost ends that session's live state, and its Playwright and Chrome close with it. In M1.1 to M1.3, if the two packages are not installed, or another Playwright provider is opened in the profile, the research preset cannot start. Outpost's research then fails immediately with the reason stated, and the top of the settings page shows 「调研跑不了：…」 (Research can't run: …). Since M1.4, research then runs on `outpost-researcher-basic`, the same preset without the browser (see [`m1.4-design.md`](m1.4-design.md)): with the packages missing, the settings page says the browser fallback is off and gives the install command; with the conflict, research sessions use the profile's own browser. 「调研跑不了：…」 shows only when neither preset loads. The settings page shows whether the browser fallback is on. When it is off, originals that cannot be opened fall back to 「待确认」 (unconfirmed).
- **dsh code conventions**: the plugin UI uses only dsh's `--dsw-alias-*` semantic variables and no color literals, so dark mode adapts automatically (`docs/web-styling.zh.md`). A plugin outside the dsh repository cannot use dsh's own CSS Modules build preset, so follow superagent: one stylesheet imported as `?raw` text and injected with a `<style>`, and all class names get the prefix `op-`. (Corrected after review)
- **Node**: the dsh 0.2.3-alpha.2 source requires Node `^24.22.3`, so upgrade it before local development (it was 24.14.1 at the time). The plugin runs inside the Electron 44 (Node 24) bundled with the desktop app and uses Node's built-in `node:sqlite`.

## 4. Choice of approach

| | Approach | Trade-offs | Verdict |
|---|---|---|---|
| 1 | **Outpost acts as its own dispatcher**: the plugin runs its own schedule in the background and opens one dsh session per product to research it. The Agent submits structured conclusions through Outpost's "hand in the work" tools, a separate fact check is started, and then everything is put together | Most work (about the size of superagent). In return it gives all the structured data the UI needs, isolates failures and cost per product, and can run in parallel | **Chosen by the user (2026-11-25)** |
| 2 | Use dsh's built-in "automation tasks": every day send one prompt into one session, and one Agent works through all the products | Less code. But it is serial and slow, one error stops everything, quality depends entirely on the Agent's own care, and profile progress / cost / change history are hard to make reliable | Not chosen |
| 3 | A standalone program like RepoRadar, with only an entry point inside dsh | Does not meet "embedded in the desktop app". The dsh plugin UI is an in-page React slot, and there is no official way to embed an external web page. It also rebuilds the Agent, search and models that dsh already has | Not chosen |

## 5. UI and interaction (decided by the user)

The sketches are in [`docs/mockups/`](../mockups/) (Chinese) (HTML fragments, open them directly in a browser; each page has two options, and the chosen one is described below). The product content in the pictures is made-up sample data.

### 5.1 Overall layout (`1-导航.html`, option B)

- The dsh left sidebar gets one more row, 「🔭 前哨」 (🔭 Outpost) (telescope icon). When there are unread new updates, the end of the row shows a number (`sidebar.panellist.trailing`).
- Clicking it opens a dsh full-page main panel (the `main` slot). Inside the panel there are **two columns**:
  - **Middle column** (about 244px, Outpost's own sub-menu), from top to bottom: the title 「前哨」 plus a 「＋ 新赛道」 (+ New track) button; **今日哨报** (Today's brief) (on the right 「n 条新」 (n new)); each **track** is a collapsible group, and under it come 「赛道概览 · 对比矩阵」 (Track overview · Comparison matrix), then the products (a blue dot if there is something new), then 「候选推荐（n 条待看）」 (Candidate recommendations (n to review)). Pinned at the bottom are **运行记录** (Run log) (on the right, today's cost) and **设置** (Settings).
  - **Right column**: the content, **filling the remaining width** (the user was explicit: no narrow centered column). Where several columns are needed, use a grid that wraps automatically; the wider the screen, the more columns.
- Selected state: light blue background + blue bold text, no vertical bar on the left.
- Option A, which was not chosen (Outpost adds its own icon bar), would end up with four columns together with the dsh sidebar. It was rejected.

### 5.2 Today's brief (`2-今日哨报.html`, option A)

- Top: the date (「11月25日 · 周二」 (Nov 25 · Tue)), one line of meta information (what time it finished, how many products, how many items are worth reading), 「‹ 昨天」 (‹ Yesterday) for paging, and 「全部已读」 (Mark all read).
- A one-sentence summary (light blue block).
- Track filter pills: 全部 (All) n · each track n.
- **One stream, sorted by importance**, one card per item. Card contents: product icon and name · track · importance tag (重要 (Important) / 值得留意 (Worth noting)); a one-line title; 「为什么值得注意」 (Why it matters); source pills; 「改了档案：定位、商业化」 (Changed the dossier: positioning, monetization); the actions 「看改动 →」 (See changes →) and 「追问」 (Follow-up).
- Minor updates are folded into one line (「另有 2 条小更新，点开看」 (2 more minor updates, click to open)); the last line is 「今天没动静：产品 A、产品 B」 (Nothing happened today: Product A, Product B).
- Shared interactions:
  - **See changes**: jump to that product's dossier, scroll to the card that was changed and expand it; newly added text has a light blue background.
  - **Follow-up**: open a new dsh session whose first message carries this update and the product's dossier, and then open that session in dsh (session name 「追问 · <产品> <标题>」 (Follow-up · <product> <title>)).
  - **Read**: a card counts as read once it scrolls out of view, and it fades. The sidebar number goes down with it, and is not shown when it reaches zero.
  - **Unconfirmed**: items without enough sources are marked 「待确认」 and are not written into the dossier (rules in §8). Note: in the sketch, the OpenAI Dots card "App Store 更新日志，只有 1 个来源，待确认" (App Store changelog, only 1 source, unconfirmed) should, under the rules as finalized in §8, count as verified (an app store changelog is an official source speaking about its own affairs). This document prevails.
  - On a day with no news there is only one line, 「今天没有值得看的变化」 (Nothing worth reading changed today).

### 5.3 New track (`3-新建赛道.html`, option B: done in place in the right column)

- Click 「＋ 新赛道」 → the track appears in the middle column at once (status 「挑选中」 (Picking), with one item below it, 「挑产品 · 已选 n」 (Pick products · n selected)), and the right column becomes the picking page.
- A three-step indicator at the top: ① 说清关注什么 (State what to watch) ② 挑产品 (Pick products) ③ 建档 (Build profiles).
- Step 1 asks only for: the track name + one sentence on 「关注什么」 (what to watch). The six default dimensions are already ticked, and custom dimensions can be added. Once confirmed, it is shown as a summary block (with 「改」 (Edit) on the right).
- Step 2: the AI searches for candidates (1–3 minutes). **Candidates pop up one by one**, so there is no need to wait for all of them. You can leave the page and come back to carry on picking.
  - Status line: 「找到 14 个候选，按热度和贴合度排好 · 用时 2 分 10 秒」 (Found 14 candidates, sorted by popularity and fit · took 2 min 10 s).
  - **One-sentence adjustment box** (「多找些国内的」 (Find more domestic ones), 「去掉硬件类」 (Drop hardware ones)): recommends again, taking the previous round's results along.
  - Groups: **强烈推荐** (Strongly recommended) (ticked by default, with 「全选这一组」 (Select this whole group)), **可以考虑** (Worth considering) (not ticked, cards more compact), **没推荐的 n 个及原因** (n not recommended, with reasons) (collapsed).
  - Candidate card (the grid fills the width): icon, name, company · 国内 (domestic) / 海外 (overseas) · form; one sentence on what it is; popularity evidence (a mini bar chart + 「找到 41 篇相关报道 · 热度上升」 (Found 41 related articles · rising)); 「为什么推荐」 (Why recommended). Selected = blue outline + a blue tick at the top right.
  - The meaning of the popularity number must be honest (my decision, added after review): dsh search does not return a total hit count and cannot filter by date (`packages/web/web/src/types.ts:31-47`), so the number can only be "the number of distinct articles the Agent actually found". It is a lower bound, not the real amount of coverage, and the wording is 「找到 n 篇」 (Found n articles). The bar chart counts articles by week of publication date; articles whose date cannot be obtained are not counted. If fewer than 5 articles have a date that can be worked out, no bar chart is drawn and only the number is written.
  - Sticky bottom bar: 「已选 5 个 · 预计每天 ¥x～y · 首次建档约 n 分钟，建好后明早出第一份哨报」 (5 selected · expected ¥x–y per day · first profile building takes about n minutes, and the first brief comes out tomorrow morning) + 「稍后再挑」 (Pick later) + 「开始跟踪 5 个」 (Start tracking 5).
- Step 3: the middle column immediately lists these products, each showing 「建档中」 (Building profile) and its progress. Each one can be viewed as soon as it is built.
- 「候选推荐」 under a track refreshes automatically once a week, and newly emerged ones are put there for you to look at.

**Adding products to an existing track (M1.2)**: once a track is being tracked, a row 「＋ 添加产品」 appears under it in the middle column, and the right column opens 「给「赛道」添加产品」 (Add products to "<track name>"), with two ways to add:

- 「知道名字」 (I know the name): fill in the product name (the official site is optional) and click 「加入并建档」 (Add and build profile). If the name matches a product Outpost is already tracking, it is added directly and only the missing dimension cards are filled in, at no cost. If it does not match, first run a 「确认产品」 (Confirm product) job (about ¥0.1–0.2, 1–2 minutes) to verify that it exists and belongs to this track. If it passes, it is added automatically and profile building starts; if it does not pass, the reason is stated. This confirmation does not count as a batch of recommendations and does not push out the candidates being picked.
- 「让前哨再找一轮」 (Let Outpost search another round): you can write a requirement in one sentence and click 「再推荐一批」 (Recommend another batch) (about ¥0.5–1, 3–4 minutes; see M1.3). The results go into 「候选推荐」 to be picked from as before.

For details see [`docs/en/m1.2-design.md`](m1.2-design.md).

### 5.4 Product dossier (`4-产品档案.html`, option A: conclusion cards + in-place expand)

- Object header: product icon (large), name, status pill (「跟踪中」 (Tracking)), 「公司 · 建档日期 · 最近更新时间」 (company · profile-building date · last updated). On the right: 「全部展开」 (Expand all), 「⋯」, and 「立即更新」 (Update now) (the primary button, near-black background with white text, the same as the dsh primary button).
- Tabs: **档案 (Dossier) ｜ 动态（n）(Updates (n)) ｜ 专题 (Topics) ｜ 来源 n (Sources n)**.
- Dossier tab:
  - **Key facts bar** (one row of equal cells): form, platform, price, launch date, benchmark product.
  - **One-line positioning** (one size larger, bold).
  - **Dimension card grid** (3 columns on a wide screen, 2 on a narrow one): each card = the dimension name (with 「今天改过」 (Changed today) if it was changed today) + 2–3 conclusions (can carry [n] citations) + 「n 个来源」 (n sources); 「展开」 (Expand) at the top right.
  - **Expand**: the card takes a whole row. The left side (about 2/3) is the full text (with citation numbers) and source pills. The right side (about 1/3) is the timeline 「这一节怎么变过来的」 (How this section changed) (date + one line on what changed, the latest one with a solid dot). 「收起 ↑」 (Collapse ↑).
- Updates tab: all findings for this product, newest first (in the same style as brief cards, including read ones and unconfirmed ones).
- Sources tab: the list of all sources (title, publisher, date, type, which conclusions cite it).
- Shared details: hovering over a citation [n] shows the source title, date and the original sentence, and clicking it opens the original page. AI inference carries an orange 「推论」 (Inference) tag. Newly added text has a light blue background that stays for 3 days and then fades. A custom dimension automatically gets one more card.

**Moving products (M1.2)**: the 「⋯」 menu in the object header has three kinds of items:

- 「移到其他赛道…」 (Move to another track…): only when the product is in exactly one track;
- 「也加到其他赛道…」 (Also add to another track…): always there. It is greyed out when there is no other track to go to, with 「还没有别的赛道」 (No other track yet) written below it;
- 「从「X」拿掉」 (Remove from "X"): when the product is in two or more tracks, one entry per track. The last one cannot be removed, and the message says to use 「暂停跟踪」 (Pause tracking).

The dossier and history are kept. The dimensions that the new track adds get their cards filled in right away. When it is done, the menu says 「已移到「X」」 (Moved to "X") or 「已加到「X」」 (Added to "X"), and if cards were filled in, 「 · 补 n 张卡」 ( · n cards filled in) is added. A product in several tracks still runs only once a day. After a removal, dimensions that none of the tracks the product is now in lists are hidden: the cards are not shown, the 「来源」 (Sources) tab lists only the sources cited by the cards that are shown, and the brief no longer names that dimension (the data is not deleted; if the product is added to a track that lists it, it comes back). For details see [`docs/en/m1.2-design.md`](m1.2-design.md).

### 5.5 Track page (`5-赛道页.html`, option A: positioning map + matrix)

- Header: the track name, 「跟踪 n 个 · 起始日期 · 每天几点 · 关注维度」 (n tracked · start date · what time each day · watched dimensions); buttons 「赛道设置」 (Track settings) and 「＋ 新专题」 (+ New topic).
- A one-sentence overview of the landscape (light blue block, labeled 「AI 归纳」 (AI summary)).
- Left half: the **positioning map**. Two-dimensional coordinates. The two axes are proposed by the AI for the track (examples: 「寄生在已有 App 里 ↔ 独立 App / 系统级」 (lives inside existing apps ↔ standalone app / system-level), 「陪聊问答 ↔ 替你办事」 (chat and Q&A ↔ does things for you)), and 「换轴」 (Change axes) at the top right lets you change them. Each product is a dot (icon + name). Its position on the day the profile was built is drawn as a dashed hollow circle, with a line to its current position. The map as a whole is inference.
- Right half: the list of **topics** (title, products involved, date of the first version, one-off / weekly update, how many places were changed last time), and the last item is 「＋ 写一个问题，AI 去深挖」 (+ Write a question, the AI digs deep).
- Below: the **comparison matrix** fills the width. Columns = products, rows = the track's watched dimensions (each cell is the one-sentence version of that product's card). Cells changed today have a light blue background + 「今天」 (Today); clicking a cell jumps to the matching card of that product. At the top right 「导出表格」 (Export table) (exporting a CSV is enough).

### 5.6 Topics

- Start: a question + choose the products involved + 「一次性 / 每周更新」 (one-off / weekly update).
- Result: the same structure as a dossier (conclusion cards first, expand to see the full text and sources). Weekly ones have 「这一版改了什么」 (What changed in this version).
- Entry points: the track page lists all of them; the 「专题」 tab on the product page lists only those related to that product.

### 5.7 Run log and settings (no sketch; made with the same components, my decision)

- **运行记录** (Run log): grouped by day, one row per run (type: 推荐 (recommend) / 建档 (profile building) / 日更 (daily update) / 核查 (fact check) / 汇总 (summary) / 专题 (topic); subject; status; duration; cost). Clicking a row opens the matching session in dsh. Failed runs show the reason and a 「重试」 (Retry) button.
- **设置** (Settings): what time to run each day (one global time, all tracks run together); the daily budget cap (a total one, and one per product); how many products run at the same time; models (M1.1: four dropdowns, 「调研（推荐·建档·日更）」 (Research (recommend · profile building · daily update)), 「核查」 (Fact check), 「写哨报总结」 (Write brief summary), 「追问」 (Follow-up); the options are all the models currently usable in dsh, grouped by provider; the last three default to 「跟调研一样」 (Same as research), and research can choose 「DeepSeek Harness 的默认模型」 (DeepSeek Harness's default model)); the data directory; whether the browser fallback is on. The config row on the plugin management page (`plugins.row.config`) holds the same form.

### 5.8 Visual conventions

- **The UI is always Chinese** (M1.1, decided by the user on 2026-11-26): it does not follow the desktop app's language. When the desktop app is in English, Outpost still shows Chinese. The English dictionary is kept, not deleted.
- Colors, fonts, corner radii, hairlines and shadows all use dsh theme variables (my decision, the user did not object): white background, DeepSeek blue `rgb(65,118,230)` as the accent, near-black body text, 0.5px hairline borders, near-black primary buttons. Dark mode switches automatically with dsh.
- Text must be large and dark: body text from 15px, reading text 15–17px, no light grey small text (the user repeatedly said in RepoRadar that grey small text strains the eyes).
- **Product icons** (the user's request): use the official icon if it can be obtained (the official site's favicon / the app store icon). Those that cannot be obtained get **one uniform color** (light blue background + blue first letter), and no random color per product. Icons are downloaded with Node `fetch` (see §3) and stored in the local data directory.
- Few words: cards carry only conclusions, and details come from expanding.

## 6. Core concepts and data

The data directory: the plugin config item `dataDir`, set on the user's machine to `~/Projects/AgentOutpost-data` (my decision: put it next to the project, like RepoRadar-data, because the user does not like projects scattered around the disk). It holds one SQLite database, the icon files, and the raw material of each run. Follow superagent's `Store`: a single SQLite file, with a directory lock taken at startup. dsh's `storageDomain` is not used, because it reads the whole block of data into memory each time and would get slow as dossiers pile up.

| Entity | Main fields | Notes |
|---|---|---|
| Track | name, one-sentence focus, list of dimensions, the two map axes, status | 6 default dimensions, and custom ones can be added. Run time and budget are global or per product, and are not attached to a track |
| Product | name, company, domestic / overseas, form, icon path, status (candidate / tracking / paused / archived), the tracks it belongs to (can be several), daily budget cap (optional) | The same product can be in several tracks, but has **only one dossier**: its dimensions = the union of the dimensions of all the tracks it belongs to, dossier cards are stored per "product + dimension", and it runs only once a day (my decision, added after review). A track page's cost = the sum of the costs of the products under it (a shared product counts in every track) |
| Candidate | track, product, tier (strongly recommended / worth considering / not recommended), one sentence, popularity evidence (article count, trend, series for the last 5 weeks), reason for recommending or excluding, batch | Each recommendation or adjustment is one batch |
| Source | URL, title, publisher, publication time, fetch time, type (official / media / user review / app store / social), whether it is an official source of that product, original quote, how it was opened during fact checking (plain fetch / browser / search snippet only / could not open) | The quote is used for hover display and for fact checking |
| Finding | product, run, title, why it matters, importance (important / worth noting / minor update), list of sources, whether it speaks of "the product's own affairs" or "what others say", fact-check status (待核查 (to be checked) / 已核实 (verified) / 待确认 (unconfirmed) / 未证实 (unproven) / 已撤回 (withdrawn)), deadline for unconfirmed ones, affected dimensions, whether it is inference, read | Brief cards are findings |
| Card | product, dimension, version number, one sentence (for the matrix), 2–3 conclusions, full text (with [n]), sources, markers for inferred fragments, fragments added in this version, change note, time | **Every modification adds a version**, and the change history is the list of versions |
| Facts | product, form, platform, price, launch, benchmark; versioned | |
| Position | track, product, date, x, y, reason | One at profile building, and one per week after that |
| Brief | date, one-sentence summary, ranked findings, minor updates, products with no news, cost | One per day (across tracks) |
| Topic | track, question, products, one-off / weekly, version (same structure as a dossier card) | |
| Run | type, subject, dsh session id, status, start / end, tokens, cost, error | The data for the run log page |

## 7. Background flow

All research happens inside dsh sessions, using Outpost's own agent preset `outpost-researcher` (defined in `cordis.patch.yml`, following superagent's `dsh-superagent-worker-preset`). It carries only the time context, `web_search`, `web_fetch`, Outpost's tools and the browser tools (included by default since M1.1, and only in this preset, see §3), and it has **no** shell and no file-writing tools. It uses the 「调研」 (Research) model from the settings (fact checking uses the 「核查」 (Fact check) model, which defaults to the same as research; M1.1). Since M1.1, research sessions are created by Outpost itself, and each run ends that session's live state when it finishes (the browser closes with it; the session record stays in the 「前哨」 workspace). The Agent does not write free-form long text. All its output is submitted through Outpost's tools:

| Tool | Purpose |
|---|---|
| `outpost_read` | Read the current product's dossier, the findings of the last 14 days and the known sources (to avoid reporting the same thing twice) |
| `outpost_submit_candidate` | During recommendation, submit candidates one by one; they show up in the UI immediately |
| `outpost_submit_card` | During profile building, submit the card for one dimension |
| `outpost_submit_facts` | Submit or change key facts |
| `outpost_submit_finding` | During a daily update, submit one finding (must carry sources and original quotes) |
| `outpost_propose_card_edit` | Propose a change to a dimension card (new text + the findings it relies on) |
| `outpost_done` | End this run, with a one-sentence summary |

The tools are written following superagent's `src/app/tools/tool.ts` (zod schema + execute). When parameter validation fails, return a readable error so the Agent can fix it itself.

### 7.1 Recommendation (new track, one-sentence adjustment, weekly refresh)
One session, 「前哨 · 推荐 <赛道>」 (Outpost · Recommend <track>). Input: the track's focus + dimensions + (when adjusting) the previous round's candidates and the adjustment request. After searching, the Agent calls `submit_candidate` for each candidate one by one, and last it submits the "not recommended" ones with their reasons. The popularity evidence must be checkable (the article count comes from counting search results, the trend from bucketing by week), and the icon is fetched when the candidate is submitted.

### 7.2 Profile building
One session per product, 「前哨 · <产品> 建档」 (Outpost · <product> profile building). It researches one dimension at a time, submits cards and key facts, and then goes on to fact checking (§7.4). After fact checking, the cards are written as version 1, and the product's initial position on the map is generated.

### 7.3 Daily increment
Every day at 08:00 by default (one global time), one session per tracked product, 「前哨 · <产品> 日更 <日期>」 (Outpost · <product> daily update <date>), with at most N running at the same time (default 3). A product that is in several tracks runs only once. The Agent first calls `outpost_read`, then looks only for "what is new since the last run" (releases, changelogs, official announcements, press coverage, user feedback), submits each item with `submit_finding`, and calls `propose_card_edit` when needed.

### 7.4 Fact check
Every finding and every card change must pass a fact check. The check is done by an independent run (a separate session or a direct model call, left to the implementer). The rules are in §8. The steps:
1. **Open the original**: first use `web_fetch` for a plain fetch. If it cannot be opened, or the content is a verification page / login page, open it with the browser (`ctx.browserUse`, needed from M1). If it still cannot be opened, see whether the original wording can be matched in the search result snippet.
2. **Match the quote**: confirm that the original quote really is on the page (or in the snippet) and supports the conclusion. If the original opened but the quote cannot be found, or the quote does not support the conclusion → **withdrawn**.
3. **Count the sources**: count the independent sources (the same press release reprinted by several outlets counts as one), and judge whether there is an official source of the product and whether it speaks about the product's own affairs.
4. **Search if short**: if it does not qualify under §8 and only one third-party corroboration is missing, the fact-check Agent searches once more itself (limit: at most 3 searches and 3 pages opened per finding), and adds what it finds to the sources.
5. **Set the status**: verified / unconfirmed (not enough sources, or the original cannot be opened and the snippet does not match either) / withdrawn.

Only "verified" items go into the dossier. "Unconfirmed" items appear only in the brief and in the updates (those that cannot be opened are marked 「原文打不开」 (original cannot be opened)). "Withdrawn" items are not shown, but the reason can be found in the run log.

**What happens to unconfirmed items**: for the next 7 days, each daily update also re-checks that product's unconfirmed findings (step 4 only). If one qualifies within 7 days it is promoted: it is written into the dossier and appears in that day's brief as 「已证实」 (confirmed). Those that still do not qualify at the deadline are marked 「未证实」, folded away from the updates (they can be expanded to view), and are not mentioned again.

### 7.5 Merge and summary
- Merge: verified card changes produce a new version, recording the added fragments (for the light blue highlight) and the change note (for the change history).
- Summary (once all products have finished, or at the deadline = 2 hours after the start, default 10:00; my decision, added after review): for products that only finish after the deadline, the results are added to that day's brief and the card is marked 「迟到」 (Late), and the sidebar number goes up with it. The summary calls the model directly (`ctx.llm.stream`, see `packages/llm/llm/README.md`), generates the one-sentence summary and the ranking of the findings, folds the minor updates, lists the products with no news, and writes the day's brief. It uses the 「写哨报总结」 model from the settings (defaults to the same as research; M1.1). The sidebar number = the number of that day's unread "important + worth noting" items.
- Weekly: refresh the candidates, update the "weekly" topics, update the map positions, and recalculate the one-sentence cells of the matrix.

### 7.6 Scheduling and catch-up
The plugin schedules itself (using a timer inside `ctx.effect`, working out the next local 08:00). It does not use dsh's schedule, which can only push one sentence into a session and cannot call the plugin's own functions. When the host starts and finds that today has not run yet and the time has passed, it catches up immediately, once. If the desktop app was closed while a run was in progress, then on the next start it carries on from the unfinished products (following superagent's `assignmentInterrupted` idea).

### 7.7 Follow-up
Create a new dsh session (the standard preset, with `outpost_read` attached; the model is the 「追问」 one from the settings, which defaults to the same as research and does not use the desktop app's default model, M1.1, because when the desktop app's default is a local model the follow-up cannot produce an answer). The first message carries this finding and a summary of the product dossier, and then the session is opened with `ctx.uiWorkspace.openSession(id)` (following `openKnownSession` in superagent `src/client/index.tsx`).

### 7.8 Cost and limits
- Cost is calculated from usage events and a price table (the price table can be changed in the settings). M1.1: local models (like Ollama) and the Claude subscription count as ¥0 and do not use the daily budget, and they run even after the budget is used up; pay-as-you-go providers other than DeepSeek are for now estimated with the same price table.
- A total daily budget and a per-product budget (optional). When a budget is exceeded, the remaining products are stopped (except those done by models counted as ¥0), and the brief says 「因预算未跑：…」 (Not run because of budget: …).
- The 「预计每天 ¥x～y」 (Expected ¥x–y per day) shown on the recommendation page and the settings page is estimated from the actual cost of the last 7 days. When there is no history, a cautious default is used and it is marked 「估算」 (estimate).

### 7.9 Failure handling
- Temporary network or model errors: following `transient()` in superagent `src/executor/dsh.ts`, back off and retry up to 3 times.
- One product failing does not affect the others. The brief says 「未能更新：产品 X（原因）」 (Could not update: product X (reason)), and the run log lets you retry.
- A stuck session (no events for a long time): cancel it after a timeout and record it as failed.

## 8. Credibility rules

1. Every conclusion must have a source and an original quote; those without are not accepted.
2. **What counts as qualified** (decided by the user on 2026-11-25):
   - **When an official source speaks about its own affairs, one source is enough**: which features were released, what changed, price, launch scope and so on, where the source is the product's official site, official blog, official WeChat account, app store changelog or official social media account. In the UI the source is marked 「官方」 (Official). From M1.6, "official" is the checker's call: it opens the page and judges whether the product's maker published it (the official domain and the mark the source came in with are only hints).
   - **What others say needs two independent sources**: user numbers, reviews, rumors, analysis and judgments. Several reprints of the same press release count as one.
   - Those that do not qualify are marked 「待确认」, are not put into the dossier, and per §7.4 more corroboration is searched for, with a 7-day deadline.
   - **An original that cannot be opened ≠ fake**: if neither plain fetch nor the browser can open it, it counts as verified when the search snippet matches the original wording; otherwise it is treated as 「待确认」, with the note 「原文打不开」.
3. The AI's own summaries and judgments (the one-sentence overview, map positions, things like "may drive traffic to e-commerce") are always marked 「推论 / AI 归纳」 (Inference / AI summary) and are not mixed in with facts.
4. A finding that fails the fact check is withdrawn as a whole, and the run log states the reason for the withdrawal.
5. Dossiers only append versions and never overwrite. Any change can be traced to a finding and a source.

## 9. How it is embedded in dsh

Follow superagent's "front half and back half" plugin package (dsh docs: `docs/user/develop/basic/publish.md`, `docs/subsystems/client-modules.md`, `docs/subsystems/slots.md`):

- **Package structure**: in `package.json`, `"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", "inject": [...] }, "manifestVersion": 1 }`, and `exports["./client"]` points to the front-end package. The inject list is copied from superagent.
- **Back half**: a Cordis plugin, `apply(ctx, config)`. The config uses Schemastery (`dataDir` is required, the rest is in §5.7; since M1.4 it is optional and defaults to `~/.outpost/data`).
- **Back-end interface**: `ctx.webServer.register({ kind: 'prefix', path: '/outpost', ... })`, mounted at `/outpost/api/*`. In alpha.2 routes have an `auth` option (`anonymous` / `required` / `deny`, default `required`, see `docs/subsystems/web-server.md:53`). Use the default `required` so the host does the authentication; the loopback-address and same-origin checks that superagent does itself (`src/app/http.ts:231-237`) can be kept as a second line of defense. The front end polls for data (following `usePoll` in superagent `src/client/api.ts`). While a run is in progress, polling speeds up (for example to 2 seconds), so that candidates and profile-building progress can pop up one by one.
- **Front half**: `ctx.slots` registers `main` (key `outpost`), `sidebar.panellist` (id `outpost`, label 「前哨」, telescope icon), `sidebar.panellist.trailing` (the unread number) and `plugins.row.config` (the settings form). The middle and right columns inside the panel are Outpost's own React components, and routing inside the panel is managed by Outpost itself.
- **Preset**: `cordis.patch.yml` inserts the Outpost plugin itself and the `outpost-researcher` preset (§7). Since M1.4 it also inserts `outpost-researcher-basic`, without the browser, which research uses when the one with the browser cannot be used.
- **Build**: the front-end package must be in the lazy-CJS `factory(require)` format that dsh requires. dsh's build preset is not published, so copy superagent's `tsdown.config.ts`. External dependencies may only use those in dsh's platform module table (`packages/client/modules/README.md`).
- **During development**: run the web version for debugging with a separate dsh directory (such as `~/.dsh-outpost`), and do not touch the desktop app's `~/.dsh` (this is also why superagent uses `~/.dsh-superagent`).
- **Installing into the desktop app**: use the `dsh` command that comes with the desktop app, or the in-app 「插件」 (Plugins) page: `dsh plugin add ~/Projects/AgentOutpost`. After a restart, 「前哨」 appears in the sidebar.

## 10. Phases

| Phase | Content | What the user can do |
|---|---|---|
| M1 Usable first | Plugin skeleton, sidebar entry, middle column; new track + recommendation (including the one-sentence adjustment); profile building; daily increments + fact check (including the browser fallback for opening WeChat official account, 小红书 and 知乎 pages, decided by the user on 2026-11-25) + summary; Today's brief; product dossier (cards, expand, change history, updates, sources); follow-up; run log; settings; budget | Create a track and see the brief the next morning |
| M2 See everything | Track page (matrix + positioning map); topics; weekly refresh of candidates | Compare side by side, dig deep into one question |
| M3 Smooth to use | Other dsh sessions can query Outpost's data (`outpost_read` opened to the outside); matrix export; dark mode checked page by page | In any conversation, ask "how is the memory capability of 豆包·小豆 in Outpost" |

At the end of each phase, run it for real in the desktop app (real search, real models), and take screenshots at 1440 and 1920 widths to check the UI.

## 11. Left for the implementer to decide

- How daily-update sessions are organized: a new session per product per day, or one long-lived session per product that is continued each day. The constraint is that the dsh session list must not be flooded (5–10 new sessions a day becomes hundreds in a month). Choose either auto-archiving or reuse, and check whether dsh supports archiving.
- Whether fact checking uses a separate session, or calls the model directly + `ctx.web.fetch`.
- ~~The default model for each kind of task~~ (decided in M1.1: each of the four places can be chosen separately, and the last three default to the same as research); the token cap for a single run (to be set after measuring).
- How to remove duplicate findings (the same thing reported by several sources counts as one).
- The exact algorithm for popularity evidence.
- How to store the "fragments added in this version" of a dossier card (character ranges or marked text).
- Front-end state management, routing inside the panel, how to split the components; whether dsh's `ui-primitives` components can be reused (limited by the platform module table).
- Whether SQLite uses Node's built-in `node:sqlite` or something else (look at which one superagent uses and at the Node version of the dsh runtime).

## 12. Open questions

The reviewer (reading it through as the implementer, 2026-11-25) raised 7 questions. Of these, 5 were decided by Claude (see §13), and the following 2 were answered by the user on 2026-11-25 ("go with the suggestions") and have been written into the body:

1. **Is the "single source" rule an exception for official sources? How does an unconfirmed item get promoted?**: when an official source speaks about its own affairs, one source is enough; what others say needs two independent sources; the fact check actively searches for corroboration; unconfirmed items have a 7-day deadline, and when it passes they are marked 「未证实」 and folded away. See §7.4 and §8.
2. **What if the original cannot be opened? Should the browser fallback be moved up to M1?**: not being able to open it does not mean withdrawn, and it is treated as unconfirmed; if the search snippet matches the original wording, it counts as verified; the browser fallback is moved up to M1. See §3, §7.4, §8 and §10.

## 13. Decided by Claude after the review (the user can change them)

- ~~Take the installed desktop 0.2.2-rc.3 as the baseline~~ → the user changed this: the desktop app and the source are upgraded together to 0.2.3-alpha.2 (§3).
- Icons are downloaded with Node `fetch`, and the host has already set up the proxy; the original statement that it "must go through ctx.web.fetch" was wrong, because it does not accept binary files (§3, §5.8).
- The popularity number is "the number of articles found". It is a lower bound, and the wording is 「找到 n 篇」 (§5.3).
- There is one global run time, not one per track; the budget is changed to a total budget + a per-product budget (§5.7, §6, §7.8).
- A product that is in several tracks still has only one dossier, with the dimensions as a union, and runs only once a day (§6, §7.3).
- The summary deadline = 2 hours after the start; late results are added to that day's brief and marked 「迟到」 (§7.5).
