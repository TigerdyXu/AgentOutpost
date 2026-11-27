# 前哨 Outpost

DeepSeek Harness 桌面版的插件，用来每天跟踪你关心的产品。

你说清关注什么，它推荐产品、给每个产品建一份带来源的档案。之后每天早上，它把这些产品的新动态查一遍、核实来源，整理成一份「今日哨报」。

![今日哨报](docs/images/today.png)

## 安装

先 ⌘Q 退出 DeepSeek Harness，再在终端运行：

```sh
gh api repos/TigerdyXu/AgentOutpost/contents/install.sh -H 'Accept: application/vnd.github.raw' | sh
```

装完后桌面版会自动打开，侧栏多出「前哨」。以后再运行这一行就是更新，你的数据和设置都会保留。

**需要准备：**
- macOS 上的 DeepSeek Harness 桌面版，0.2.3-alpha.2 系列，并且已经登录 DeepSeek。
- GitHub CLI，并已执行 `gh auth login`（仓库是私有的）。
- Google Chrome，可选。前哨用它打开公众号、知乎这类需要验证的网页。

## 怎么用

**1. 建赛道。** 点「＋ 新赛道」，写赛道名和一句话关注点，再点「开始找候选」。AI 会一边搜一边列出候选产品，你勾选想跟的，然后开始跟踪。

<img src="docs/images/new-track.png" width="760" alt="新建赛道">

**2. 看档案。** 每个产品按维度建卡片，比如定位、目标人群、体验、商业化，每句话都能点开看来源。「动态」页按时间列出它的新消息。

<img src="docs/images/product.png" width="760" alt="产品档案">

**3. 每天看哨报。** 前哨每天定时去查，默认 08:00。值得看的排在前面，每条都过了核查；对哪条有疑问，点「追问」直接聊。

**4. 加产品、换赛道。** 在赛道下点「＋ 添加产品」：知道名字就直接填；不知道就让前哨再推荐一批。产品页右上角的「⋯」菜单里，可以把产品移到或也加到别的赛道。

<img src="docs/images/add-product.png" width="760" alt="添加产品">

## 花费

按前哨自己的记录：
- 给一个产品建档：约 ¥0.5；
- 每个产品每天的日更加核查：约 ¥0.5；
- 新建赛道时找一批候选：约 ¥0.4。

在「设置」里可以设每日预算，花到上限后当天就停。如果模型选本机的 Ollama 或 Claude 订阅，前哨按 ¥0 记，也不占预算。

> 这些数字还没算联网搜索：DeepSeek 处理每次搜索都要另调一次模型，费用另算。实际花了多少，以 DeepSeek 的账单为准。

## 更多

- 设计：[docs/设计文档.md](docs/设计文档.md)
- 开发、手动安装和退回旧版本：[dev/README.md](dev/README.md)
