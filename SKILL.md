---
name: G-zhen-lan-pachong
description: 箴爬虫。本机网页抓取/爬虫 skill——站点资产发现（sitemap/JS路由/子域/端口建图）、目标导向找参考件（discover→hunt 定位页面再深采）、单页正文抽取、SPA 的 JS 渲染抓取、全站镜像爬取、UI 组件采集（把网页上一个可见控件/组件采成脱敏的复刻任务书 markdown）。触发词：爬/抓/抓取/爬虫/scrape/crawl/扒/镜像站/保存网页/全站离线镜像/作品离线搬运/套壳/扒课件/采组件/采集组件/扒组件/harvest/这个控件怎么实现/复刻组件/这个站有哪些页面/登录页在哪/站点地图/找参考文件/找不到页面/discover/hunt/资产发现。当需要把网页内容（文章、文档、列表、整个小站、UI 组件）抓成本地 Markdown/HTML 时使用。姊妹 skill：G-zhen-wangluo（视频/媒体下载/截图，不管正文与组件）；组件采来后用 G-zhen-ui（箴UI craft）重写。
version: 2.2.0
---

# G-zhen-lan-pachong 箴爬虫

本机网页抓取 skill。**专项专干**：凡是"拉网页内容"——单页或全站——都用我，不靠 `web_fetch` 在 JS 站面前缩头。

## 什么时候用我

- 抓一篇文章/文档 → 干净 Markdown（去导航/广告/页脚）
- 网页是 JS 渲染的 SPA，`web_fetch` 只拿到空壳 → CDP 连共享系统 Chrome(9222) 渲染后抽（禁下载 chromium）
- 批量/全站抓（文档站、博客、小站）→ katana 发现链接 + 队列逐页抓
- 把网页存成自包含 HTML（内联图片/CSS 离线可看）→ monolith 归档
- 以上都失败 → 截图，交 image 工具视觉识别
- **采网页上的一个 UI 组件/控件**（按钮、表单、卡片、导航、订阅框、滑块面板…）→ 组件采集（见下「UI 组件采集」），产脱敏「组件复刻任务书」markdown

**不要用我做的**：下视频/音频/图片流（那是 G-zhen-wangluo 箴网络）；登录态/付费墙内容（先问 G 先生）；**拆解某个插件/JS 的加密或混淆逻辑**（那是 G-zhen-nixiang 箴逆向——「拆明白一个黑盒」归它，「采页面内容」归我）；**根据采集稿把组件写成我们自己的代码**（那是 G-zhen-ui 箴UI craft——我只管「采进来」，箴UI 管「生成出来」）。

> **第四类活：批量拉「数据型站点」的 API 数据**（题库/表格/列表型 SaaS，目标是把结构化数据拉进本地库，不是抽文章正文）。scrape/crawl 不适用（trafilatura 抽不出 JSON 列表、katana 发现不了 XHR），走专门分支，见 `references/api-bulk-harvest.md`（SPA 接口定位、分页/限速/断点续传、Referer 鉴权文件下载、**对账本硬要求**）。触发："把这个站的数据全拉下来/拉题库/批量导出列表数据/拉它后台的XX"。

> **第五类活：网站作品/资产全量镜像（离线化搬运）**（教育课件社区、H5 作品平台：作品要原样搬到本地、断网可跑、不依赖源站）。不是抽正文也不是拉 JSON，核心是"多代际作品形态 + 三层资产（HTML/CSS/JS 相对引用）+ 绝对 URL 离线改写 + 运行时服务登记 + 断网真机验收"。只解析 HTML 壳会漏 CSS 字体与 `media/{id}` 相对媒体目录；"下载完成"≠"可离线引用"。见 `references/work-mirror.md`（CDP 摸代际接口/公开池与登录态全量两套列表的差集/legacy 老代被平台停发/单线程防 WAF/403 与熔断分级/脱离会话进程编排/增量基线防重下/六问交付清单）。触发："把这站作品全扒下来离线用/套壳到我们页面/不依赖源站任何服务"。

## 工具链（全部本机已装，零 npm 依赖）

| 工具 | 角色 | 体积 | 位置 |
|------|------|------|------|
| curl.exe | 静态页最快抓取 | 系统自带 | PATH |
| trafilatura | 正文抽取黄金标准 | ~6MB | Python 包 |
| beautifulsoup4 + markdownify | 通用 HTML→MD 回退（文档/参考页） | pip | Python 包 |
| Playwright + 系统Chrome(CDP 9222) | 本地 JS 渲染 | 已装 | Python 包，Chrome 走共享实例 |
| katana | 链接发现/全站 map | 60.8MB | `~/go/bin/katana.exe` |
| monolith | 单页自包含归档 | 5.3MB | 随skill自带 `bin/vendor/monolith.exe`（router相对路径直调） |
| firecrawl | SaaS 渲染兜底 | npm 全局 | 未认证=免费限速档 |
| Chrome 截图 | 终极视觉兜底 | 已装 | CDP / Playwright |

> 选型铁律：依赖的外部工具必须有 Windows 预编译 binary 或 pip/npm 单包安装，**绝不要求装编译器/Perl/系统构建链**。

## 懒老板阶梯（从快到慢、本地到云端）

**单页**（`scrape.mjs`，auto 模式自动逐级降级）：
1. `curl` + trafilatura（SSR 静态页，秒级，纯本地）
2. trafilatura 抽不到 → bs4+markdownify 通用回退
3. Playwright 经 CDP 渲染系统 Chrome(9222) + trafilatura（SPA/JS）
4. firecrawl scrape（SaaS，要联网）
5. monolith 归档（`--archive`，存自包含 HTML，不抽正文）
6. 全失败 → Playwright 截图，调 image 工具识别

**全站**（`crawl.mjs`）：katana map 发现同域 URL → 过滤静态资源/去重/限深 → 逐页走抓取链（默认 curl+trafilatura；`--js` 加 Playwright；`--firecrawl` 加云端兜底）→ 存 `{domain}/{path}/index.md` + `_manifest.json`。

**先建图再定向找件**（`discover.mjs` → `hunt.mjs`，2026-10-12 新增，治「全站抓了一堆还是找不到要参考的页面」）：
1. `discover.mjs <url>` 只读建站点资产图：robots/sitemap（含 sitemapindex 递归与 .gz）→ 首页链接 → **JS bundle 里的路由字面量（专治 React/Next/Vue 深页无 `<a>` 链接）** → crt.sh 证书透明被动收子域 → TCP 连接探 Web 端口（nmap 在则自动改用 nmap）。产 `site-map.json` + 人看的 `site-map.md`。
2. `hunt.mjs --map site-map.json --target "登录 login"`：对候选页**轻量探一次**（取标题+正文头 3KB，不全文下载）按目标词中英文打分排序，产 `hunt-result.md`；只对强命中跑 harvest/scrape 深采。多个需求重复 `--target`。
3. 实测：wulikanjian 499 页中 hunt「下载/播客」精准把 /downloads(11分)、/podcasts(9分) 排前二。

> 侦察边界（铁律）：discover/hunt 全程**只读公开信息**，不试口令、不利用漏洞、不发攻击流量。`--enumerate`（常见子域名/后台路径清单猜查）请求量大、对方日志明显，**默认关闭，只对自有或明确授权目标开**。端口扫描是正常侦察动作默认开启（`--ports web|common|none`）。箴辅导上线前的攻击性自检（弱口令/漏洞验证）走后续单独立项的防御打靶模块，不塞进爬虫。

> 全站链路按 YAGNI 只保留产出文本的级（curl→Playwright→firecrawl）。monolith 归档/截图不产文本且批量太重，不在全站链路里；需要时对单页用 `scrape --archive`。

## 网络环境与代理分流（国内直连，不许国内流量走代理）

**铁律：国内域名一律直连，代理只服务境外站。** 依据：G先生 2026-10-03 令；v2rayN 只是兜底工具，国内链路不得依赖它。

| 层 | 做法 |
|---|---|
| curl 级 | 命中国内后缀 → 自动加 `--noproxy <host>`，即使环境里挂了 `HTTPS_PROXY` 也不进代理 |
| Playwright/CDP | 每个 context 统一 `proxy=socks5://127.0.0.1:10808, bypass=<CN名单>`：目标页与国内 CDN（如 hdslb.com）直连，境外请求才走 socks |

- 国内判定：`*.cn` ＋ `references/cn-domains.txt`（~150 常用后缀，按 label 精确匹配，`evilbilibili.com` 不会误判）。同一份名单 mjs/py 共用；只放确属国内的域名，不确定别加。
- 覆盖开关：`Z_PROXY_SERVER` 换代理出口；`Z_NO_PROXY=1` 全部直连（抓纯国内站时可用）。
- 代理不通（refused/timeout）→ 停手汇报，不精重试；与箴网络同一口径。
- **开工先判国别，国内站绝不挂代理绕回国内**（2026-10-12 G先生问立）：动手抓站第一件事＝确认目标是国内还是境外。国内域名（命中 cn 名单）代码已自动 `--noproxy` 直连，**不要**为图省事 `export HTTPS_PROXY=...` 把全局流量塞进 socks5——国内站绕境外代理一圈既慢又可能被风控。抓之前先在命令行验一次：`curl.exe --noproxy "*" -sS -o NUL -w "%{http_code}" "<国内URL>"`，直连通就别带代理。
- **代理站的本地侦察盲区**（discover 专用）：境外走 socks5 时 DNS 解析发生在代理远端，本机 `dns.resolve4` 会得 NXDOMAIN——此时**页面/sitemap/JS 路由发现照常**（请求经代理），但**端口探测和子域 IP 解析无效**。日志出现 `DNS ... NXDOMAIN` 且页面却能抓到，就是这个盲区，不是站点不存在；要端口/子域结果须在能直连目标的网络跑，别把 NXDOMAIN 写进结论当事实。

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

# 先建站点资产图（sitemap/JS路由/子域/Web端口）→ site-map.md/json
node "$skill\bin\discover.mjs" "https://example.com" -v
# 含常见服务端口（SSH/DB/RDP 等）；连子域一起扫端口
node "$skill\bin\discover.mjs" "https://example.com" --ports common --scan-subdomains
# 清单猜查（常见后台路径/子域）——仅自有或授权目标，动静大
node "$skill\bin\discover.mjs" "https://example.com" --enumerate --confirm-loud

# 目标导向定位参考件（先 discover 再 hunt，中英文关键词都给）
node "$skill\bin\hunt.mjs" --map "桌面\zhenpachong\example.com\site-map.json" --target "登录 login" --target "注册 register"
# 命中后再深采（组件用 harvest，正文用 scrape）

# 全站 + JS 渲染 + firecrawl 兜底（SPA 站，慢）
node "$skill\bin\crawl.mjs" "https://app.example.com" --js --firecrawl --depth 1 --limit 50

# 只抓匹配的路径，排除静态/分页
node "$skill\bin\crawl.mjs" "URL" --include "/docs/*" --exclude "*/tag/*"

# 采 UI 组件 → 脱敏复刻任务书 markdown（详见上文「UI 组件采集」）
node "$skill\bin\harvest.mjs" "URL" --selector "footer.newsletter" --name "newsletter-footer"
node "$skill\bin\harvest.mjs" "本地.html" -s ".subscribe" -s ".card" -n "form" -n "card" -v --json

# 跑测试（70 个：router 26 + component-md 15 + proxy 8 + netproxy 3 + discover-core 18）
# 统一用通配写法：`node --test tests/` 目录形式在 Node 24/26 均失效，npm test 已内置此写法
cd $skill; node --test tests/*.test.mjs
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
- discover `--ports web|common|none`：端口探测范围（默认 web 九端口；nmap 存在自动升级为服务识别）；`--scan-subdomains` 连子域一起扫；`--no-crt` 跳过证书透明查询；`--enumerate` 必须配 `--confirm-loud` 双闸才执行（高动静，仅授权目标；软 404 基线自动剔除假命中）；`--sitemap-depth N` 子 sitemap 递归层数（默认 3，非法值回退）
- hunt `--target` 可重复（中英双语命中更准）；`--max-probe N` 轻探页上限（默认 60，先按 URL 信号排序再探）；4xx/5xx 页面剔除，不允许路径名撞关键词造成假命中

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
- **国内流量不许走代理**（v2.1.3）：curl 级对命中 cn-domains.txt 的目标自动 --noproxy；CDP context 以 socks5+bypass 全量 CN 名单创建。代理只管境外，v2rayN 挂了国内链路不受影响。
  - **v2.1.4 复审修复**：补 crawl.mjs 漏写的 import（全站爬取原必挂）；境外主文档不再被误加 bypass（原裸加任何主机，被墙站主文档直连必败）；截图兑底改 new_context 隔离登录态；--filename 净化防路径穿越；剥离提示改 class token 精确匹配（原子串匹配可误删正文）；curl 境外显式 -x、katana -proxy、monolith 清/设代理环境变量；名单去重，新增 Python 分流测试。
  - **v2.1.5 二次复审修复**：safeArgName 对未传 --filename 的 null 输入返回字面量 "null"，导致默认产物全叫 null.*（回归）；已移入 router.mjs 纯函数，空输入返回 ""，并对 Windows 保留设备名（CON/NUL/COMx 等）加下划线前缀；新增 3 个回归测试（51 全绿）。
  - **v2.1.6 靶子边界入规**（小茉莉更正函建议）：动态应用站（bilibili 等）不作正文抽取回归目标，抽不到正文、回退 playwright-raw 是正常降级，不判回退；详见「质量纪律」。无代码改动，51 测试不变。
- **门户首页抽取质量**（小茉莉反馈，非链路问题）：gov.cn 首页 trafilatura 仅出 112 字节，method/errors 正常；需要门户全文时加 `--format html` 或浏览器级，属上游抽取局限，不做定向补丁。

## 架构（跟箴网络一脉相承）

- `bin/lib/router.mjs`：纯函数——URL/选项→策略、工具路径探测、文件名生成。零副作用，可独立测试。
- `bin/lib/run.mjs`：`spawnSync` 数组参数安全封装（防 shell 注入）。
- `bin/lib/component-md.mjs`：**组件采集纯函数**——DOM 脱敏白名单、设计 token 反推、任务书 markdown 渲染、文件名生成。零副作用，可独立测试。
- `bin/extract.py`：trafilatura 正文抽取（precision→recall→bs4/markdownify 三级）。
- `bin/render.py`：Playwright 渲染（含自动滚屏触发懒加载）。
- `bin/scrape.mjs`：单页降级链入口。
- `bin/crawl.mjs`：全站 katana+队列。
- `bin/lib/discover-core.mjs`：**资产发现纯函数**——同域链接（仅返回同注册域）/JS bundle/路由字面量提取、sitemap（含索引/gz）/robots 解析、子域归集、hunt 中英双语打分排序、SSRF 作用域闸。零副作用，18 个测试。
- `bin/discover.mjs`：资产图编排——sitemap 递归、JS 路由、crt.sh 被动子域、node:net 内置 TCP 端口探针（nmap 可选增强）、`--enumerate` 清单猜查，落 site-map.json/md。
- `bin/hunt.mjs`：目标导向定位——吃 site-map，轻量探测（标题+正文头 3KB + HTTP 状态）打分排序，落 hunt-result.json/md。
- `tests/discover-core.test.mjs`：18 测试（同域链接/JS 路由去噪/sitemap 容器严格分类/robots/子域/作用域闸 isInScope 与私网拒绝/多目标评分排序）。
- `bin/harvest.mjs`：**组件采集编排**——调 harvest.py 拿 JSON → component-md 渲染任务书 → 落盘。
- `bin/harvest.py`：Playwright 开页（URL/本地文件）→ 注入采集器 → 按 selector 采 → 输出 JSON。
- `bin/harvest-inject.js`：**自写页面采集器**（注入目标页跑）——视觉宿主/交互识别/原始样式表规则（@media/:hover/var/clamp）/脱敏，本地返回不外传。
- `bin/lib/netproxy.py`：国内/境外代理分流（cn-domains.txt；给 Playwright context 产 socks5+bypass 配置）。
- `bin/lib/proxy.mjs`：同一分流规则的 mjs 端（curl --noproxy 参数）。
- `references/cn-domains.txt`：国内直连后缀清单（mjs/py 唯一共享数据源）。
- `tests/proxy.test.mjs`：8 测试（CN 后缀/标签边界/名单去重/curl 参数/代理环境变量/loopback 与 RFC1918 本地地址强制直连）。
- `tests/netproxy.test.mjs`：3 测试（Python 分流跨进程断言：外域不进 bypass、国内进 bypass、Z_NO_PROXY）。
- `tests/router.test.mjs`：26 测试
- **v2.2.0 资产发现**（借鉴 ARTEX 资产图/探索图思路，只取只读侦察层）：新增 discover/hunt 双入口；proxy.mjs 补 loopback/内网地址（含 IPv6 ULA/LL 与 ::ffff 映射）强制直连，本地打靶/CDP 不再被 socks5 吞。**fresh-context 复审后修复 4 严重 +5 中等**：① sitemap 递归改 BFS 分层（旧 depth 计数会让分片大站只抓前 3~4 个 sitemap）；② 作用域闸 isInScope——sitemap/robots 声明的越界地址（含 169.254.169.254 云元数据/内网）一律丢弃，curl 跳转在 JS 侧逐跳校验不跨主机，加 `--proto =http,https`；③ 种子只收 http(s)，拒 file:// 等协议；④ .gz sitemap 改临时文件二进制抓取（utf8 解码会毁 gzip 字节，旧版必坏）；⑤ urlset 严格按容器分类不再猜文件名；⑥ enumerate 双闸 +软 404 基线（随机不存在路径对照，401/403 单列为认证信号）；⑦ hunt 校验 map URL 作用域、记录跳转 ↪；⑧ argv 注入防御（URL 前加 `--`）。已知限制：走代理的境外目标本地 DNS 可能 NXDOMAIN，端口/子域侦察需直连环境；hunt 为标题级匹配，同义改名页可能漏判，关键词中英文都给。（策略路由 + runTool 安全/stdin 回归 + extract.py 集成 + safeArgName 空值/穿越/保留名回归）。
- **v2.2.0 箴代码双轴复审清理**（2026-10-12，Standards 轴 FAIL / Spec 轴 PASS，论据全部主 agent 实测后处理）：删除死代码——discover/hunt 复制残留的 `__dirname`＋fileURLToPath 导入、全仓零调用的 `classifyProbe`（连其测试）、extractLinks 无消费方的 external 桶（改只返回同域 URL 数组）、isInScope 永不可达的 `allowPrivate` 形参分支、curlOnce 断链的 accept 透传、crtShSubdomains 重复的 `o.crt` 短路、stale「legacy」注释；接线而非删——robotsDisallow 与子域 openPorts 改为真在 site-map.md 渲染。**Spec 轴抓到一个真实越权口**：hunt 原 `-sSL` 自动跟随 302 不过作用域闸，候选页 302 到第三方时会下载并给外域正文打分；改为 JS 侧逐跳跟随（≤5、每跳 isInScope、跨域判 dead，本地 302→example.com 实测不打分）；discover/hunt 的 curl 统一加 `--max-filesize 5MB`；nmap 端口串改由 WEB/COMMON_PORTS 派生防漂移；UA 下沉 DISCOVER_UA 单点。70 测试全绿。
- `tests/component-md.test.mjs`：15 测试（脱敏白名单 + 攻击样例：script/style 标签体、hidden csrf、预填 email/phone、截断边界不泄漏；token 反推；任务书段落与安全契约；文件名）。

## 质量纪律（箴代码）

- 改完跑 `node --test tests/*.test.mjs` 必须全绿（Node ≥26 不接受目录参数）。

### ⛔ 外部输入门禁（新增「抓取/发请求/读文件」代码时逐条跑，不是建议是 checklist）

> 2026-10-12 v2.2.0 血训：复审一次抓出 4 严重，全因 happy-path 测试默认外部输入善意。凡是新写的代码会**拿外部内容去发请求或读文件**（sitemap/robots/跳转 Location/响应里的 URL/map JSON/用户给的 URL），合并前必须逐条有**对抗测试**且全绿。缺任一条不许提交。

1. **协议白名单**：`file://`、`dict://`、`gopher://` 种子必须退出码非 0；curl 统一带 `--proto "=http,https"`。写一条非法协议测试断言抛错/退出。
2. **作用域闸**：外部内容声明的越界 URL（其他注册域、`169.254.169.254` 云元数据、`192.168.*`/`10.*`/`127.*` 内网，除非种子本身就是它）必须被丢弃并在 `-v` 留痕。构造一个指向 169.254 的 sitemap 测试。
3. **跳转不跨主机**：不自动跨域跟随 3xx，逐跳在 JS 侧过作用域闸、限跳数（≤5）；写一条 302→外域被拦的测试。
4. **二进制走字节**：.gz 等压缩响应必须拿原始 Buffer（临时文件 `-o` 或 buffer 编码），禁止经 utf8 管道；写一个 gzip 压缩 sitemap 端到端断言解出页面。
5. **软 404**：猜查/探测先打一个随机不存在路径建立基线，同码同长判假命中剔除，不许只认硬 404。
6. **argv 注入**：来自数据的 URL 前加 `--`，并断言以 `http(s)://` 开头；用 `"-Oevil"` 这类串验证不会被当成 curl 参数。
7. **递归按层不按弹出数**：sitemapindex 多分片用 BFS 分层，写「一个索引挂 ≥10 个分片」用例证明全抓到（旧计数只抓前 3~4 个）。

判据：每条都要有**会先变红**的对抗测试（先构造恶意输入确认现状会为害，再加防护转绿），只测正常输入不算数。
- 纯逻辑进 router.mjs/discover-core.mjs 先写测试；子进程调用走 runTool 数组参数，**禁止字符串拼 shell**。
- discover/hunt 只做公开只读侦察；`--enumerate` 与任何攻击性动作仅限自有/书面授权目标，产物里保留探测来源留痕。
- 不自审：动完核心逻辑派 fresh-context 子 agent 复审。
- **正文抽取回归靶子必须匹配本 skill 用途**（2026-10-03 小茉莉误报事件后立规）：回归固定用文档/文章类页面（文档站、博客文章页、政务正文页）。bilibili 这类动态应用站 HTML 无文章正文，抽取落空、回退原始网页（playwright-raw）属降级链正常兜底，**不判定为回退缺陷**；此类站只作反广告提示夹具，不作正文靶子。要 B 站内容（视频/字幕/评论）走 G-zhen-wangluo。判定前先问「这个站该不该由箴爬虫测」。

