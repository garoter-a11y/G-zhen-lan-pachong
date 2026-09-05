---
name: G-zhen-lan-pachong
description: 箴爬虫。本机网页抓取/爬虫 skill——单页正文抽取、SPA 的 JS 渲染抓取、全站镜像爬取、UI 组件采集（把网页上一个可见控件/组件采成脱敏的复刻任务书 markdown）。触发词：爬/抓/抓取/爬虫/scrape/crawl/扒/镜像站/保存网页/采组件/采集组件/扒组件/harvest/这个控件怎么实现/复刻组件。当需要把网页内容（文章、文档、列表、整个小站、UI 组件）抓成本地 Markdown/HTML 时使用。姊妹 skill：G-zhen-wangluo（视频/媒体下载/截图，不管正文与组件）；组件采来后用 G-zhen-ui（箴UI craft）重写。
version: 2.1.0
---

# G-zhen-lan-pachong 箴爬虫

本机网页抓取 skill。**专项专干**：凡是"拉网页内容"——单页或全站——都用我，不靠 `web_fetch` 在 JS 站面前缩头。

## 什么时候用我

- 抓一篇文章/文档 → 干净 Markdown（去导航/广告/页脚）
- 网页是 JS 渲染的 SPA，`web_fetch` 只拿到空壳 → 本地 Chromium 渲染后抽
- 批量/全站抓（文档站、博客、小站）→ katana 发现链接 + 队列逐页抓
- 把网页存成自包含 HTML（内联图片/CSS 离线可看）→ monolith 归档
- 以上都失败 → 截图，交 image 工具视觉识别
- **采网页上的一个 UI 组件/控件**（按钮、表单、卡片、导航、订阅框、滑块面板…）→ 组件采集（见下「UI 组件采集」），产脱敏「组件复刻任务书」markdown

**不要用我做的**：下视频/音频/图片流（那是 G-zhen-wangluo 箴网络）；登录态/付费墙内容（先问 G 先生）；**拆解某个插件/JS 的加密或混淆逻辑**（那是 G-zhen-nixiang 箴逆向——「拆明白一个黑盒」归它，「采页面内容」归我）；**根据采集稿把组件写成我们自己的代码**（那是 G-zhen-ui 箴UI craft——我只管「采进来」，箴UI 管「生成出来」）。

## 工具链（全部本机已装，零 npm 依赖）

| 工具 | 角色 | 体积 | 位置 |
|------|------|------|------|
| curl.exe | 静态页最快抓取 | 系统自带 | PATH |
| trafilatura | 正文抽取黄金标准 | ~6MB | Python 包 |
| beautifulsoup4 + markdownify | 通用 HTML→MD 回退（文档/参考页） | pip | Python 包 |
| Playwright + Chromium | 本地 JS 渲染 | 已装 | Python 包 |
| katana | 链接发现/全站 map | 60.8MB | `~/go/bin/katana.exe` |
| monolith | 单页自包含归档 | 5.3MB | `D:\tools\monolith\monolith.exe` |
| firecrawl | SaaS 渲染兜底 | npm 全局 | 未认证=免费限速档 |
| Chrome 截图 | 终极视觉兜底 | 已装 | CDP / Playwright |

> 选型铁律：依赖的外部工具必须有 Windows 预编译 binary 或 pip/npm 单包安装，**绝不要求装编译器/Perl/系统构建链**。

## 懒老板阶梯（从快到慢、本地到云端）

**单页**（`scrape.mjs`，auto 模式自动逐级降级）：
1. `curl` + trafilatura（SSR 静态页，秒级，纯本地）
2. trafilatura 抽不到 → bs4+markdownify 通用回退
3. Playwright 渲染 Chromium + trafilatura（SPA/JS）
4. firecrawl scrape（SaaS，要联网）
5. monolith 归档（`--archive`，存自包含 HTML，不抽正文）
6. 全失败 → Playwright 截图，调 image 工具识别

**全站**（`crawl.mjs`）：katana map 发现同域 URL → 过滤静态资源/去重/限深 → 逐页走抓取链（默认 curl+trafilatura；`--js` 加 Playwright；`--firecrawl` 加云端兜底）→ 存 `{domain}/{path}/index.md` + `_manifest.json`。

> 全站链路按 YAGNI 只保留产出文本的级（curl→Playwright→firecrawl）。monolith 归档/截图不产文本且批量太重，不在全站链路里；需要时对单页用 `scrape --archive`。

## UI 组件采集（harvest）

把网页上**一个看得见的组件/控件**（按钮、表单、卡片、导航、订阅框、滑块面板…）采成本地**脱敏的「组件复刻任务书」markdown**，供下游照它的交互/布局/状态、用项目**自有 DESIGN.md** 重写。

> **它是什么 / 不是什么**（边界，别误用）：
> - 是**组件级**采样（一个控件/一块区域），**不是**整站爬虫、**不是**动效/页面全量抓取。
> - 产物是「从活页面逆向的体检报告」（descriptive），讲组件现在长什么样、有哪些交互/状态；**不是**施工图纸。
> - 采集依赖活页面浏览器 API（getComputedStyle / DOM / 样式表规则），Node/CLI 干不了，必须走 Playwright/CDP（本 skill 链路现成）。

### 双线（走哪条都行）

**① 内置线（自动、可复现、可批量、可进流水线）——首选**

```powershell
$skill = "C:\Users\Administrator\.openclaw\workspace\skills\G-zhen-lan-pachong"

# 采一个组件（URL 或本地 .html 都行）
node "$skill\bin\harvest.mjs" "https://example.com/" --selector "footer.newsletter" --name "newsletter-footer"

# 一次采多个（selector 与 name 按顺序对应）
node "$skill\bin\harvest.mjs" "URL" -s ".subscribe" -s ".card" -n "subscribe-form" -n "card" -v

# 指定输出目录 / 等待时间 / 视口 / JSON 摘要
node "$skill\bin\harvest.mjs" "URL" -s "nav" -o "D:\Temp\comp" --wait 3000 --viewport 1280x800 --json
```

默认输出：`桌面\zhenpachong\<域名>\components\<组件名>.md`（本地文件落在 `local-components\components\`）。

内置线相对浏览器插件多三件事：**可复现/可批量**、**能进门禁流水线**、**读原始样式表规则**——同源 CSS 的 `@media`/`:hover`/`var()`/`clamp()`/`minmax()` 原文都能拿到（`getComputedStyle` 死像素快照拿不到响应式规则）。跨域 CDN 样式表被 CORS 拦截时，产物里**如实标注**「N 个样式表未取到」，缺失部分按自有体系补并标【推测】。

**② 插件线（人工点选，零散场景）**

G先生 在日常 Chrome 装 **Com-Pick** 插件（第三方闭源，作者「Sue的AI知识库」），在参考站 hover 点选组件 → 复制「给 AI」的 markdown → 存到 `桌面\zhenpachong\<域名>\components\<组件名>.md`，同样当复刻饲料。适合「我看到这个控件不错，顺手采它」。

> 内置采集器 `harvest-inject.js` 为**自写**（学 Com-Pick 的方法：视觉宿主上溯 / 交互识别 / 脱敏白名单 / 任务书话术，不逐字搬 content.js）。**自写是工程选择不是版权洁癖**：箴爬虫已有 router/run/Playwright 架构、selector 驱动比人工 hover 更可复现可批量，且不需要 Com-Pick 的 Figma 链路（figit 9.6MB）与悬浮 picker UI 包袱（YAGNI）。注：G-zhen 仓全 **PRIVATE 自用、不构成公开分发**（2026-09-05 复盘），在私有仓里参考/移植闭源代码法律风险≈0；将来若仓改 PUBLIC 或打进发外部用户的产品，再核 LICENSE。figit.js 是开源 bundle，真要搬 Figma 链路前核其捆绑库 LICENSE。

### 产物（任务书 markdown）含什么

组件摘要（尺寸/交互计数）· 通用交互契约（input/button/link/slider/switch，动作走 props+callback）· 设计 Token 反推（颜色/圆角/字号/字体，仅供参考）· **响应式规则**（@media 原文）· **状态**（:hover/:focus/::placeholder/[aria-]）· **原始样式规则**（var()/clamp() 活值）· 关键视觉 CSS（当前视口计算值）· 清理后 DOM · 安全清理清单 · 验收要求。

**脱敏是硬门禁**（采集器自动做）：剥事件处理（on*）、href/action/src、内联 style；属性走**白名单**（id/class/role/type/name/aria-*/data-state 等结构属性），其余全删——这一刀同时去掉 token/auth/session/cookie/csrf/secret/password/email/phone 等敏感属性和 analytics/gtm/segment/tracking 埋点属性；链接 `<a>` 转 `role="button" tabindex="0"`（无导航目标）。

### 采完之后（复刻边界）

- **复刻 ≠ 照抄**：照任务书的**交互/布局/状态**，用项目**自有 DESIGN.md token** 重新实现；不搬外站 DOM/CSS/字体/外链资源/像素死值。任务书里 5 条复刻纪律（仅增量添加 / 不抄业务逻辑请求埋点凭证 / 缺失状态标【推测】/ 动作走 props+callback / 视觉用自有体系）逐条遵守。
- **教学动画内核不走这条线**：数学公式、几何引擎、帧理 SVG、GeoGebra ggb —— 这些靠箴视野「查源复刻」（db / decrypted / ggb xml），网页组件采集拿的是渲染后像素，取不到公式逻辑。组件采集只用于**课件外壳 UI 控件**（quiz-card 面板滑块/按钮、双 Tab 外壳、进度控件等）。
- 职责路由：**采** → 箴爬虫（本 skill）；**写成我们的代码** → 箴UI craft；**拆插件/JS 黑盒** → 箴逆向；**下媒体/截图** → 箴网络。

## 怎么调（命令速查）

```powershell
$skill = "C:\Users\Administrator\.openclaw\workspace\skills\G-zhen-lan-pachong"

# 单页抓正文 → Markdown，自动降级
node "$skill\bin\scrape.mjs" "https://example.com/article"

# 指定输出目录 + JSON 结果摘要 + 详细日志
node "$skill\bin\scrape.mjs" "URL" -o "D:\Temp\out" --json -v

# 强制用浏览器渲染（已知是 SPA）
node "$skill\bin\scrape.mjs" "URL" --mode browser

# 同时存一份自包含 HTML 归档（monolith）
node "$skill\bin\scrape.mjs" "URL" --archive

# 输出 HTML 而不是 Markdown
node "$skill\bin\scrape.mjs" "URL" --format html

# 全站爬取（同域，深度2，限100页，限速）
node "$skill\bin\crawl.mjs" "https://docs.example.com" --depth 2 --limit 100 --delay 300 -v

# 全站 + JS 渲染 + firecrawl 兜底（SPA 站，慢）
node "$skill\bin\crawl.mjs" "https://app.example.com" --js --firecrawl --depth 1 --limit 50

# 只抓匹配的路径，排除静态/分页
node "$skill\bin\crawl.mjs" "URL" --include "/docs/*" --exclude "*/tag/*"

# 采 UI 组件 → 脱敏复刻任务书 markdown（详见上文「UI 组件采集」）
node "$skill\bin\harvest.mjs" "URL" --selector "footer.newsletter" --name "newsletter-footer"
node "$skill\bin\harvest.mjs" "本地.html" -s ".subscribe" -s ".card" -n "form" -n "card" -v --json

# 跑测试（38 个：router 23 + component-md 15）
cd $skill; node --test tests/router.test.mjs tests/component-md.test.mjs
```

默认输出：`C:\Users\Administrator\Desktop\zhenpachong\<域名>\...`

## 关键参数

- `--mode auto|curl|browser|firecrawl|screenshot`：强制某一级；默认 auto 自动降级
- `--format markdown|html|text`：默认 markdown
- `--no-scroll`：渲染时不自动滚动触发懒加载
- `--wait MS`：渲染后等待毫秒（默认 2500）
- `--archive`：额外用 monolith 存自包含 HTML
- crawl `--js`：启用 katana headless + Playwright 渲染（慢，但能抓 SPA 全站）
- crawl `--firecrawl`：本地两级失败后用 firecrawl SaaS 兜底（每页云端调用，慢/限速，按需开）
- crawl `--concurrency N`：katana 并发（1-8）；`--delay MS`：每页间隔（礼貌限速）

## 路径探测与环境变量覆盖

`bin/lib/router.mjs` 是唯一真相源，自动探测工具真实路径。可用环境变量覆盖：
`PYTHON_PATH` `CURL_PATH` `KATANA_PATH` `MONOLITH_PATH` `FIRECRAWL_PATH` `CHROME_PATH`。

## 已知坑（血训）

- **monolith 2.10.x 在 Windows 上 `-o <path>` 会 panic**（"could not prepare output"）。解决：用 `-o -` 输出到 stdout，Node 端自己写文件。scrape.mjs 已处理。
- **spawnSync stdio[0] 必须是 "pipe"**，否则 `input` 参数被静默丢弃（Python 读到空 stdin 报"input too short"）。已修，有回归测试。
- **katana 会返回 CSS/JS/图片 URL**，crawl.mjs 默认过滤 30+ 静态扩展名。
- **trafilatura 对非文章页（文档/参考/表格页）可能抽空**，extract.py 自动回退 bs4+markdownify（剥 nav/footer/aside 后转 MD）。
- **`looksLikeShell` 字数阈值不能当 gate**：example.com 这种短而合法的页会被误判成 SPA。已改为总让 trafilatura 自己判断，shell 检测只做日志。
- **写自定义抓取脚本时**：requests/httpx 已装（需复杂 cookie/会话/HTTP2 时用），lxml 已装（xpath 解析）。但日常抓取优先用上面的降级链，别重造。

## 架构（跟箴网络一脉相承）

- `bin/lib/router.mjs`：纯函数——URL/选项→策略、工具路径探测、文件名生成。零副作用，可独立测试。
- `bin/lib/run.mjs`：`spawnSync` 数组参数安全封装（防 shell 注入）。
- `bin/lib/component-md.mjs`：**组件采集纯函数**——DOM 脱敏白名单、设计 token 反推、任务书 markdown 渲染、文件名生成。零副作用，可独立测试。
- `bin/extract.py`：trafilatura 正文抽取（precision→recall→bs4/markdownify 三级）。
- `bin/render.py`：Playwright 渲染（含自动滚屏触发懒加载）。
- `bin/scrape.mjs`：单页降级链入口。
- `bin/crawl.mjs`：全站 katana+队列。
- `bin/harvest.mjs`：**组件采集编排**——调 harvest.py 拿 JSON → component-md 渲染任务书 → 落盘。
- `bin/harvest.py`：Playwright 开页（URL/本地文件）→ 注入采集器 → 按 selector 采 → 输出 JSON。
- `bin/harvest-inject.js`：**自写页面采集器**（注入目标页跑）——视觉宿主/交互识别/原始样式表规则（@media/:hover/var/clamp）/脱敏，本地返回不外传。
- `tests/router.test.mjs`：23 测试（策略路由 + runTool 安全/stdin 回归 + extract.py 集成）。
- `tests/component-md.test.mjs`：15 测试（脱敏白名单 + 攻击样例：script/style 标签体、hidden csrf、预填 email/phone、截断边界不泄漏；token 反推；任务书段落与安全契约；文件名）。

## 质量纪律（箴代码）

- 改完跑 `node --test tests/` 必须全绿。
- 纯逻辑进 router.mjs 先写测试；子进程调用走 runTool 数组参数，**禁止字符串拼 shell**。
- 不自审：动完核心逻辑派 fresh-context 子 agent 复审。
