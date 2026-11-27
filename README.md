# 前哨 Outpost

简体中文 · [English](README.en.md)

DeepSeek Harness 桌面版的插件，用来每天跟踪你关心的产品。

你说清关注什么，它推荐产品、给每个产品建一份带来源的档案。之后每天早上，它把这些产品的新动态查一遍、核实来源，整理成一份「今日哨报」。

![前哨演示：今日哨报、产品档案、新建赛道](docs/images/demo.gif)

## 安装

先 ⌘Q 退出 DeepSeek Harness，再在终端运行：

```sh
curl -fsSL https://raw.githubusercontent.com/TigerdyXu/AgentOutpost/master/install.sh | sh
```

装完后桌面版会自动打开，侧栏多出「前哨」。以后再运行这一行就是更新，你的数据和设置都会保留。

**需要准备：**
- macOS 上的 DeepSeek Harness 桌面版，0.2.3-alpha.2 系列，并且已经登录 DeepSeek。
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

用 DeepSeek（deepseek-flash）时的大致花费，已算上联网搜索：
- 给一个产品建档：约 ¥1–2；
- 每个产品每天的日更加核查：约 ¥0.5–1；
- 新建赛道时找一批候选：约 ¥0.5–1。

DeepSeek 在工作日高峰（北京时间 9–12 点、14–18 点）以外半价，08:00 的日更正好在闲时。在「设置」里可以设每日预算，花到上限后当天就停。如果模型选本机的 Ollama 或 Claude 订阅，前哨按 ¥0 记，也不占预算。

> 这些都是估算。DeepSeek Harness 不报告每次联网搜索实际用了多少，前哨按每次约 8000 输入、800 输出 token 估算。实际花了多少，以 DeepSeek 的账单为准。

## 更多

- 设计：[中文](docs/设计文档.md) · [English](docs/en/design.md)
- 开发、手动安装和退回旧版本：[dev/README.md](dev/README.md)

## 许可

[MIT](LICENSE)
