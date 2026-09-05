/**
 * component-md — pure helpers for the UI-component harvest pipeline.
 *
 * Three responsibilities, all side-effect free and unit-testable:
 *   1. sanitizeDomString() — strip a live DOM snippet down to a structural
 *      skeleton (allowlist attributes only; no handlers/hrefs/credentials/tracking).
 *   2. inferTokens()       — cluster repeated computed styles into design tokens.
 *   3. buildComponentMarkdown() — render the "component replication task sheet"
 *      (the markdown an agent consumes to re-implement the component in its own system).
 *
 * Methodology (allowlist sanitization, interaction contract, additive-only task
 * wording) is learned from the closed-source Com-Pick extension's approach; no
 * third-party code is copied. See SKILL.md "组件采集".
 *
 * @module component-md
 */

// ── Sanitization ───────────────────────────────────────

/** Attribute names that survive on the structural skeleton. */
const ATTR_ALLOWLIST = new Set([
  "id", "class", "role", "type", "name", "placeholder", "for", "alt",
  "title", "tabindex", "checked", "disabled", "selected", "required", "readonly",
  "min", "max", "step", "pattern", "autocomplete", "colspan", "rowspan", "hreflang",
]);
/** data-* attributes are dropped EXCEPT pure structural state. */
const DATA_ALLOWLIST = new Set(["data-state"]);
/** name/id/for values that label a sensitive field → drop the attribute too. */
const SENSITIVE_NAME = /csrf|token|secret|passwd|password|email|e-?mail|phone|mobile|\btel\b|auth|session|api[-_]?key|account|idcard|身份证|手机|邮箱|密码/i;
/** Whole elements removed (open+close) — their bodies can carry scripts/beacons/tracking. */
const DANGER_PAIR_RE = /<(script|style|iframe|noscript|template|object|embed)\b[\s\S]*?<\/\1\s*>/gi;
/** Void/self-closing non-structural elements removed outright. */
const DANGER_VOID_RE = /<(link|meta|base|param)\b[^>]*>/gi;

function isAllowedAttr(name) {
  const n = name.toLowerCase();
  if (ATTR_ALLOWLIST.has(n)) return true;
  if (n.startsWith("aria-")) return true; // accessibility always survives
  if (n.startsWith("data-")) return DATA_ALLOWLIST.has(n);
  return false;
}

/** Parse a tag's attribute string into [name, value|null] pairs. */
function parseAttrs(attrText) {
  const out = [];
  const re = /([^\s=]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(attrText)) !== null) {
    const name = m[1];
    if (!name || name.startsWith("<") || name.startsWith("/")) continue;
    const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : null;
    out.push([name, value]);
  }
  return out;
}

function quoteAttr(value) {
  if (value === null) return "";
  return `="${String(value).replace(/"/g, "&quot;")}"`;
}

/**
 * Reduce a live DOM string to a safe structural skeleton.
 * - Removes whole <script>/<style>/<iframe>/<link>/<meta>/… elements (their bodies
 *   carry inline tracking, beacons, or credentials) and hidden inputs (csrf tokens).
 * - Removes: event handlers (on*), href/action/src, inline style, prefilled `value`,
 *   and every attribute NOT on the structural/aria allowlist (this drops token/auth/
 *   cookie/csrf/secret/password/email/phone and analytics/gtm/segment/tracking).
 * - Converts anchors <a> to generic buttons (role="button" tabindex="0"), so no
 *   navigation target survives.
 * - When maxLen is given, truncates on a tag boundary (never inside a tag), so a cut
 *   tail cannot leak an unsanitized half-attribute.
 * Idempotent. Never throws.
 */
export function sanitizeDomString(html, maxLen) {
  if (!html || typeof html !== "string") return "";
  let s = html;

  // 1. Drop whole active/non-structural elements (bodies included).
  s = s.replace(DANGER_PAIR_RE, "");
  s = s.replace(DANGER_VOID_RE, "");
  // 2. Drop hidden inputs entirely (csrf/anti-forgery tokens, etc.).
  s = s.replace(/<input\b[^>]*>/gi, tag => (/\btype\s*=\s*["']?hidden/i.test(tag) ? "" : tag));

  // 3. Tag-by-tag attribute allowlist.
  s = s.replace(/<(\/?)([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\s*(\/?)>/g, (whole, slash, tag, attrText, selfClose) => {
    const tagLower = tag.toLowerCase();
    const attrs = parseAttrs(attrText || "");
    const kept = [];

    for (const [name, value] of attrs) {
      const ln = name.toLowerCase();
      // Never carry prefilled values (PII / tokens / csrf) — the agent recreates state.
      if (ln === "value") continue;
      // name/id/for that label a sensitive field → drop (don't point at email/phone/csrf).
      if ((ln === "name" || ln === "id" || ln === "for") && value && SENSITIVE_NAME.test(value)) continue;
      if (isAllowedAttr(name)) {
        // Never let a surviving attribute smuggle a handler/url in its value.
        const v = value === null ? "" : String(value).replace(/\s*on\w+\s*=[^"']*/gi, "");
        kept.push(value === null ? name : `${name}="${v.replace(/"/g, "&quot;")}"`);
      }
    }

    // Anchors carry navigation → neutralize into generic interactive buttons.
    if (!slash && tagLower === "a") {
      if (!kept.some(a => /^role=/i.test(a))) kept.push('role="button"');
      if (!kept.some(a => /^tabindex=/i.test(a))) kept.push('tabindex="0"');
    }

    const attrStr = kept.length ? " " + kept.join(" ") : "";
    return `<${slash}${tag}${attrStr}${selfClose ? " /" : ""}>`;
  });

  // 4. Optional hard cap on a tag boundary.
  if (maxLen && s.length > maxLen) {
    const cut = s.lastIndexOf(">", maxLen);
    s = (cut > 0 ? s.slice(0, cut + 1) : s.slice(0, maxLen)) + "\n<!-- …DOM truncated… -->";
  }
  return s;
}

// ── Token inference ────────────────────────────────────

function rgbToHex(str) {
  const m = String(str).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
  if (!m) return String(str);
  if (m[4] !== undefined && parseFloat(m[4]) === 0) return null; // fully transparent
  return "#" + [m[1], m[2], m[3]].map(n => parseInt(n, 10).toString(16).padStart(2, "0")).join("");
}

function isTransparent(v) {
  return !v || v === "transparent" || /rgba\([^)]*,\s*0(?:\.0+)?\s*\)/i.test(v);
}

/**
 * Cluster an array of computed-style objects into design tokens.
 * @param {Array<Record<string,string>>} styles
 * @returns {{colors:Array<{value:string,count:number,role:string}>, radii:string[], fontSizes:string[], fontFamily:string}}
 */
export function inferTokens(styles) {
  const colorCount = new Map();
  const radii = new Set();
  const fontSizes = new Set();
  let fontFamily = "";

  for (const s of styles || []) {
    for (const [prop, val] of Object.entries(s || {})) {
      if (prop === "color" || prop === "backgroundColor" || prop === "borderColor") {
        if (isTransparent(val)) continue;
        const hex = rgbToHex(val) || val;
        if (!hex) continue;
        const role = prop === "backgroundColor" ? "背景" : prop === "borderColor" ? "边框" : "文字";
        const cur = colorCount.get(hex) || { count: 0, roles: new Set() };
        cur.count += 1;
        cur.roles.add(role);
        colorCount.set(hex, cur);
      } else if (prop === "borderRadius") {
        if (val && val !== "0px" && val !== "0" && val !== "none") radii.add(val);
      } else if (prop === "fontSize") {
        if (val && val !== "0px") fontSizes.add(val);
      } else if (prop === "fontFamily" && !fontFamily && val && !/none|^$|generic/i.test(val)) {
        fontFamily = String(val).split(",")[0].replace(/["']/g, "").trim();
      }
    }
  }

  const colors = [...colorCount.entries()]
    .map(([value, c]) => ({ value, count: c.count, role: [...c.roles].join("/") }))
    .sort((a, b) => b.count - a.count);

  return {
    colors,
    radii: [...radii],
    fontSizes: [...fontSizes].sort((a, b) => parseFloat(a) - parseFloat(b)),
    fontFamily,
  };
}

// ── File naming ────────────────────────────────────────

/** Turn a free-form component name into a safe lower-snake .md filename. */
export function componentFileName(name) {
  const base = String(name || "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\w\u4e00-\u9fff-]+/g, "-") // keep letters/digits/CJK; drop punctuation
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "component"}.md`;
}

// ── Markdown task sheet ────────────────────────────────

function cssBlock(visualCss) {
  const lines = [];
  for (const item of visualCss || []) {
    const decls = Object.entries(item.css || {})
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => {
        const prop = k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
        return `  ${prop}: ${v};`;
      });
    lines.push(`${item.selector} {`);
    lines.push(...decls);
    lines.push("}");
  }
  return lines.join("\n");
}

/**
 * Render the component replication task sheet (markdown).
 * @param {object} data  - harvested component payload (dom/visualCss/stateRules/responsiveRules/interactive/stylesheets)
 * @param {{url:string, capturedAt:string, mode:string, selector?:string, tag?:string, rect?:object}} meta
 * @returns {string}
 */
export function buildComponentMarkdown(data, meta) {
  const m = meta || {};
  const d = data || {};
  const safeDom = sanitizeDomString(d.dom || "", 20000);
  const tokens = inferTokens((d.visualCss || []).map(x => x.css));
  const rect = d.rect || {};
  const inter = d.interactive || {};
  const sheets = d.stylesheets || { total: 0, readable: 0, blocked: 0 };

  const colorLines = tokens.colors.length
    ? tokens.colors.map(c => `  - \`${c.value}\` ×${c.count}（${c.role}）`).join("\n")
    : "  - （未反推出显著颜色）";
  const radiusLine = tokens.radii.length ? tokens.radii.join(" / ") : "（无圆角或全直角）";
  const fontLine = tokens.fontSizes.length ? tokens.fontSizes.join(" / ") : "（未采集到）";
  const blockedNote = sheets.blocked > 0
    ? `\n> ⚠️ ${sheets.blocked} 个样式表跨域被 CORS 拦截、原始规则未取到（共 ${sheets.total} 个，可读 ${sheets.readable} 个）。下列响应式/状态规则可能不完整，缺失部分按项目自有设计体系补全并标注【推测】。`
    : "";

  const responsive = (d.responsiveRules && d.responsiveRules.length)
    ? d.responsiveRules.map(r => `\`${r.media}\`\n\`\`\`css\n${r.cssText}\n\`\`\``).join("\n\n")
    : "未检测到 media query。" + (sheets.blocked > 0 ? "（可能因跨域样式表未取到，见上方警告）" : "（该组件在采集视口下无响应式规则，或为内联样式）");

  const states = (d.stateRules && d.stateRules.length)
    ? d.stateRules.map(r => `- \`${r.selector}\`：\`\`\`css\n${r.cssText}\n\`\`\``).join("\n")
    : "未检测到 `:hover` / `:focus` / `[aria-expanded]` 等状态规则。缺失状态请按目标设计系统补全，并标注【推测】。";

  const interLines = [
    `- 输入框 ×${inter.inputs || 0}：本地 value + onChange，原 name/action 已移除`,
    `- 按钮 ×${inter.buttons || 0}、链接 ×${inter.links || 0}：链接已转为通用按钮语义；所有通用动作通过 **props + 回调（callback）** 暴露，不复制原站跳转/请求`,
    `- 滑块 ×${inter.sliders || 0}、开关 ×${inter.switches || 0}：状态本地管理，变更走回调`,
    (inter.details && inter.details.length)
      ? inter.details.map(x => `- 交互元素：${x.tag || x.role || ""} ${x.label || ""}（${x.interaction || x.role || ""}）`.trim()).join("\n")
      : "",
  ].filter(Boolean).join("\n");

  return `# 组件复刻任务

> 本文件由箴爬虫组件采集生成，是「从活页面逆向的体检报告」，不是施工图纸。
> 复刻 = 照它的**交互/布局/状态**，用项目**自有 DESIGN.md token** 重新实现；不照搬像素、不抄业务逻辑。

## 目标位置
- 来源页：${m.url || "（未记录，采集不收集业务路由）"}
- 选择器：\`${d.selector || m.selector || "（未提供）"}\`
- 根标签：\`${d.tag || m.tag || "?"}\`
- 采集时间：${m.capturedAt || "?"}
- 采集方式：${m.mode === "plugin" ? "浏览器插件（Com-Pick 人工点选）" : "箴爬虫 harvest 内置线（Playwright 自动采集）"}
> 复刻到哪个文件/页面由执行者填写。

## 组件摘要
- 尺寸（采集视口下计算值）：宽 ${Math.round(rect.width) || "?"}px × 高 ${Math.round(rect.height) || "?"}px
- 交互元素：输入框 ${inter.inputs || 0} · 按钮 ${inter.buttons || 0} · 链接 ${inter.links || 0} · 滑块 ${inter.sliders || 0} · 开关 ${inter.switches || 0}

## 通用交互
${interLines}
- 可访问性：保留的 aria-* / role 见下方 DOM；复刻时补齐 focus 态、对比度、触摸目标 ≥44px。

## 设计 Token（反推，仅供参考）
> 复刻时以项目自有 DESIGN.md token 为准，下列像素/色值用于理解节奏，不直接照抄。
- 颜色：
${colorLines}
- 圆角：${radiusLine}
- 字号：${fontLine}
- 字体：${tokens.fontFamily || "（未采集到）"}

## 响应式规则
${blockedNote}

${responsive}

## 状态
${states}

## 安全清理清单
- 已剥离：事件处理（on*）、href/action/src、内联 style；非白名单属性全删（含 token/auth/session/cookie/csrf/secret/password/email/phone/address/account 等敏感属性，以及 analytics/gtm/segment/mixpanel/tracking 等埋点属性）。
- 链接 \`<a>\` 已转为 \`role="button" tabindex="0"\` 通用语义，无导航目标。
- 复刻纪律（逐条遵守）：
  1. **仅增量添加**：不修改/删除/覆盖目标页已有任何组件、内容、样式、逻辑。
  2. **不复制**原站业务逻辑、网络请求、跳转、埋点、凭证或用户数据。
  3. 缺失状态可按目标设计系统补全，但**必须标注【推测】**。
  4. 通用动作通过 **props / callback** 暴露，输出可访问、可维护组件。
  5. 视觉用项目**自有 DESIGN.md** 重写，不引入外站字体/外链资源/像素死值。

## 清理后 DOM
\`\`\`html
${safeDom}
\`\`\`

## 关键视觉 CSS（当前视口计算值）
\`\`\`css
${cssBlock(d.visualCss)}
\`\`\`

## 原始样式规则（同源样式表原文，含 var()/clamp()/minmax() 活值）
> 这些是**规则原文**不是计算值，保留了设计 token 变量与响应式函数，比上方死像素更适合复刻；跨域样式表取不到时见上方 CORS 警告。
\`\`\`css
${(d.baseRules && d.baseRules.length) ? d.baseRules.join("\n\n") : "（未取到同源原始规则；跨域或纯内联样式时如此）"}
\`\`\`

## 验收要求
- [ ] 组件可独立运行、无 JS 报错、画布/区域非空白。
- [ ] 交互完整（输入/按钮/状态），动作全部走 props/callback，无原站请求/跳转。
- [ ] 可访问：对比度 ≥4.5:1、可见 focus、aria 齐全、触摸目标 ≥44px。
- [ ] 响应式：按上方 media 规则实现；跨域缺失部分按自有体系补并标【推测】。
- [ ] 视觉对齐项目 DESIGN.md，零外网引用。
`;
}
