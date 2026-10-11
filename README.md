# G-zhen-lan-pachong 箴爬虫

> 本机网页抓取 / 爬虫 skill — 站点资产发现 · 目标导向找参考件 · 单页正文抽取 · JS 渲染抓取 · 全站镜像爬取。
> 零 npm 依赖，clone 即用（外部工具均为预编译 binary 或 pip 包）。

## 它解决什么

`web_fetch` 遇到 JS 渲染的站点只返回空壳；手写 requests 又要逐个对付反爬、SPA、懒加载。箴爬虫把本机已有的抓取手段整合成一条**自动降级链**：从最快的静态抓取逐级升级到浏览器渲染、SaaS、截图，不用每次自己判断该用哪个。

- **单页**：curl + trafilatura 抽正文 → bs4/markdownify 回退 → Playwright 渲染 → firecrawl → monolith 归档 → 截图
- **全站**：katana 高速发现链接 → 过滤/去重/限速 → 逐页抓取（curl+trafilatura；`--js` 加 Playwright；`--firecrawl` 加云端兜底）→ Markdown 镜像 + manifest

> 全站链路只保留产出文本的级。monolith 归档/截图不产文本且批量太重，不在全站链路；需要时对单页用 `scrape --archive`。

## 安装

外部工具（本机已装；换机时照此补齐）：

```powershell
# Python 库
pip install trafilatura beautifulsoup4 markdownify playwright
# 禁止 playwright install：渲染级一律 CDP 连共享系统 Chrome(9222)，启动：
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<G-zhen-wangluo>\bin\start-chrome-9222.ps1"

# katana（Go 单文件 binary，~60MB）
go install github.com/projectdiscovery/katana/cmd/katana@latest
#   或从 https://github.com/projectdiscovery/katana/releases 下 katana_windows_amd64.zip

# monolith（Rust 单文件 binary，~5MB）已随 skill 自带：bin/vendor/monolith.exe
#   router 用相对路径直调，无需另放 D:\tools；可用 MONOLITH_PATH 覆盖
```

工具路径由 `bin/lib/router.mjs` 自动探测，可用环境变量覆盖：
`PYTHON_PATH` `CURL_PATH` `KATANA_PATH` `MONOLITH_PATH` `FIRECRAWL_PATH` `CHROME_PATH`。

## 用法

### 单页抓取

```powershell
$skill = "C:\Users\Administrator\.openclaw\workspace\skills\G-zhen-lan-pachong"

# 自动降级，抓成 Markdown
node "$skill\bin\scrape.mjs" "https://example.com/article"

# 输出目录 / JSON 摘要 / 详细日志
node "$skill\bin\scrape.mjs" "URL" -o "D:\Temp\out" --json -v

# 已知是 SPA，强制浏览器渲染
node "$skill\bin\scrape.mjs" "URL" --mode browser

# 同时存自包含 HTML 归档（离线可看，图/CSS 全内联）
node "$skill\bin\scrape.mjs" "URL" --archive

# 要 HTML / 纯文本
node "$skill\bin\scrape.mjs" "URL" --format html
node "$skill\bin\scrape.mjs" "URL" --format text
```

`--mode`：`auto`（默认）| `curl` | `browser` | `firecrawl` | `screenshot`

默认输出：`C:\Users\Administrator\Desktop\zhenpachong\<域名>\...`

### 全站爬取

```powershell
# 同域，深度 2，限 100 页，每页间隔 300ms
node "$skill\bin\crawl.mjs" "https://docs.example.com" --depth 2 --limit 100 --delay 300 -v

# SPA 全站（katana headless + Playwright 渲染，慢）
node "$skill\bin\crawl.mjs" "https://app.example.com" --js --depth 1 --limit 50

# 本地两级失败后用 firecrawl 云端兜底
node "$skill\bin\crawl.mjs" "https://site.example.com" --js --firecrawl --limit 100

# 路径过滤
node "$skill\bin\crawl.mjs" "URL" --include "/docs/*" --exclude "*/tag/*"
```

产物：`<output>/<url路径>/index.md` + `<output>/_manifest.json`（每页用了哪个工具、字数、失败原因）。

### 资产发现 + 目标导向找参考件（discover → hunt）

治「全站抓了一堆还是找不到要参考的页面」。全程只读公开信息；清单猜查 `--enumerate` 默认关、只打自有/授权目标。

```powershell
# 建站点资产图：robots/sitemap（含索引/gz）+ 首页链接 + JS bundle 路由（SPA 深页）
# + crt.sh 被动子域 + TCP Web 端口（nmap 存在自动升级）→ site-map.json/md
node "$skill\bin\discover.mjs" "https://example.com" -v
node "$skill\bin\discover.mjs" "https://example.com" --ports common --scan-subdomains
node "$skill\bin\discover.mjs" "https://example.com" --enumerate --confirm-loud   # 双闸，授权目标限定

# 在资产图里定位要找的页面（轻探标题+正文头，打分排序）→ hunt-result.md
node "$skill\bin\hunt.mjs" --map "<out>\site-map.json" --target "登录 login" --target "下载 download"
# 强命中再交 harvest（采组件）或 scrape（抽正文）深采
```

## 降级链原理

| 级 | 工具 | 适用 | 速度 |
|----|------|------|------|
| 1 | curl + trafilatura | SSR 静态文章 | 秒级，纯本地 |
| 2 | bs4 + markdownify | trafilatura 抽不到的文档/参考页 | 秒级 |
| 3 | Playwright → 系统Chrome(CDP 9222) | JS 渲染的 SPA | 10-30秒 |
| 4 | firecrawl | 强反爬/需云端渲染 | 联网，限速 |
| 5 | monolith | 自包含 HTML 归档（不抽正文） | 10-60秒 |
| 6 | 截图 + image 识别 | 以上全失败 | 兜底 |

auto 模式下，前一级失败（抓不到 / 抽不出正文）才升级到下一级。

## 测试

```powershell
cd C:\Users\Administrator\.openclaw\workspace\skills\G-zhen-lan-pachong
node --test tests/*.test.mjs   # Node ≥26 不接受目录参数
```

70 个测试（router 26 + component-md 15 + proxy 8 + netproxy 3 + discover-core 18）。覆盖：策略路由、路径探测、URL→文件名、runTool 安全调用 / stdin 回归 / 防注入、extract.py 正文抽取集成、国内外代理分流（curl 参数 / proxy env / Python CDP bypass / loopback 与 IPv6 私网强制直连）、组件脱敏、资产发现解析（sitemap 严格分类/robots/JS 路由/子域/作用域 SSRF 闸/评分排序/404 剔除）。

## 已知坑

- **monolith 2.10.x 在 Windows 上 `-o <path>` 会 panic**。代码里用 `-o -` 走 stdout 再自行写文件绕过。
- **katana 返回 CSS/JS/图片 URL**，crawl.mjs 默认过滤 30+ 静态扩展名。
- 写自定义脚本时 requests/httpx/lxml 都已装，但日常优先用现成降级链。

## 文件结构

```
G-zhen-lan-pachong/
├── SKILL.md              # Agent 加载的技能说明
├── README.md             # 本文件
├── package.json
├── LICENSE
├── bin/
│   ├── scrape.mjs        # 单页降级链入口
│   ├── crawl.mjs         # 全站 katana + 队列
│   ├── discover.mjs      # 只读资产发现：sitemap/JS路由/子域/端口
│   ├── hunt.mjs          # 目标导向定位参考件（轻探打分）
│   ├── extract.py        # trafilatura + bs4/markdownify 正文抽取
│   ├── render.py         # Playwright 渲染
│   └── lib/
│       ├── router.mjs      # 纯函数：策略/路径探测/文件名（唯一真相源）
│       ├── discover-core.mjs # 纯函数：链接/JS路由/sitemap/robots/子域/打分
│       ├── run.mjs       # spawnSync 数组参数安全封装
│       ├── proxy.mjs     # Node 侧国内外代理分流
│       └── netproxy.py   # Python 侧 Playwright context proxy/bypass
└── tests/                # 70 tests：router/component-md/proxy/netproxy/discover-core
```

## 姊妹 skill

- **G-zhen-wangluo 箴网络** — 视频/音频/流媒体下载（B站/YouTube/P站等），不管网页正文。
- 分工：**抓内容→箴爬虫；下媒体→箴网络。**

## License

MIT
