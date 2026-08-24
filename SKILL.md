---
name: G-zhen-lan-pachong
description: 箴爬虫。本机网页抓取/爬虫 skill——单页正文抽取、SPA 的 JS 渲染抓取、全站镜像爬取。触发词：爬/抓/抓取/爬虫/scrape/crawl/扒/镜像站/保存网页。当需要把网页内容（文章、文档、列表、整个小站）抓成本地 Markdown/HTML 时使用。姊妹 skill：G-zhen-wangluo（视频/媒体下载，不管正文抓取）。
version: 2.0.0
---

# G-zhen-lan-pachong 箴爬虫

本机网页抓取 skill。**专项专干**：凡是"拉网页内容"——单页或全站——都用我，不靠 `web_fetch` 在 JS 站面前缩头。

## 什么时候用我

- 抓一篇文章/文档 → 干净 Markdown（去导航/广告/页脚）
- 网页是 JS 渲染的 SPA，`web_fetch` 只拿到空壳 → 本地 Chromium 渲染后抽
- 批量/全站抓（文档站、博客、小站）→ katana 发现链接 + 队列逐页抓
- 把网页存成自包含 HTML（内联图片/CSS 离线可看）→ monolith 归档
- 以上都失败 → 截图，交 image 工具视觉识别

**不要用我做的**：下视频/音频/图片流（那是 G-zhen-wangluo 箴网络）；登录态/付费墙内容（先问 G 先生）。

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

# 跑测试
cd $skill; node --test tests/router.test.mjs
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
- `bin/extract.py`：trafilatura 正文抽取（precision→recall→bs4/markdownify 三级）。
- `bin/render.py`：Playwright 渲染（含自动滚屏触发懒加载）。
- `bin/scrape.mjs`：单页降级链入口。
- `bin/crawl.mjs`：全站 katana+队列。
- `tests/router.test.mjs`：23 测试（策略路由 + runTool 安全/stdin 回归 + extract.py 集成）。

## 质量纪律（箴代码）

- 改完跑 `node --test tests/` 必须全绿。
- 纯逻辑进 router.mjs 先写测试；子进程调用走 runTool 数组参数，**禁止字符串拼 shell**。
- 不自审：动完核心逻辑派 fresh-context 子 agent 复审。
