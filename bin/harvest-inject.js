/*
 * harvest-inject.js — runs INSIDE the target page (injected via Playwright).
 * Self-written collector. Methodology (visual-host walk-up, interaction
 * recognition, original-stylesheet rule extraction, allowlist sanitization)
 * is inspired by the closed-source Com-Pick extension; no third-party code
 * is copied. Everything here is local-only: the payload is returned to the
 * local Playwright driver, never sent over the network.
 *
 * Exposes window.__zhenHarvest(selector) -> payload object.
 */
(function () {
  "use strict";

  var MAX_HTML_CHARS = 20000;  // cap flag for serialized DOM (truncation itself is Node-side, boundary-safe)
  var MAX_VISUAL_ELS = 12;     // root + most significant children for computed CSS
  var MAX_RULE_CHARS = 600;    // per-rule cssText cap

  // Computed-style props worth keeping (visual rhythm). Everything else is noise.
  var VISUAL_PROPS = [
    "backgroundColor", "color", "borderRadius", "padding", "margin",
    "fontSize", "fontFamily", "fontWeight", "lineHeight", "boxShadow",
    "border", "display", "gap", "flexDirection", "alignItems", "justifyContent",
    "width", "maxWidth", "minHeight", "textAlign",
  ];

  function simpleSelector(el, root) {
    if (el === root) return null; // caller supplies the root selector
    if (el.id) return "#" + el.id;
    var cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean);
    if (cls.length) return el.tagName.toLowerCase() + "." + cls.slice(0, 2).join(".");
    var role = el.getAttribute("role");
    if (role) return el.tagName.toLowerCase() + '[role="' + role + '"]';
    var al = el.getAttribute("aria-label");
    if (al) return el.tagName.toLowerCase() + '[aria-label="' + al + '"]';
    return el.tagName.toLowerCase();
  }

  function visualSignificance(el) {
    // interactive / heading / media elements rank highest for computed CSS
    var tag = el.tagName.toLowerCase();
    if (["input", "button", "select", "textarea", "a"].indexOf(tag) >= 0) return 3;
    var role = el.getAttribute("role") || "";
    if (["slider", "switch", "tab", "button", "combobox"].indexOf(role) >= 0) return 3;
    if (/^h[1-6]$/.test(tag)) return 2;
    var cs = getComputedStyle(el);
    if (cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent") return 2;
    if (parseFloat(cs.borderRadius) > 0) return 1;
    return 0;
  }

  function collectVisual(root, rootSelector) {
    var out = [];
    var rootCs = getComputedStyle(root);
    var rootCss = {};
    VISUAL_PROPS.forEach(function (p) { rootCss[p] = rootCs.getPropertyValue(propToCss(p)) || rootCs[p]; });
    out.push({ selector: rootSelector, css: rootCss });

    var kids = Array.prototype.slice.call(root.querySelectorAll("*"))
      .map(function (el) { return { el: el, sig: visualSignificance(el) }; })
      .filter(function (x) { return x.sig > 0; })
      .sort(function (a, b) { return b.sig - a.sig; })
      .slice(0, MAX_VISUAL_ELS);

    var seen = {}; // dedup by full selector: same-class elements share styles
    kids.forEach(function (x) {
      var sel = simpleSelector(x.el, root);
      if (!sel) return;
      var fullSel = rootSelector + " " + sel;
      if (seen[fullSel]) return;
      seen[fullSel] = true;
      var cs = getComputedStyle(x.el);
      var css = {};
      VISUAL_PROPS.forEach(function (p) {
        var v = cs.getPropertyValue(propToCss(p)) || cs[p];
        if (v && v !== "none" && v !== "normal" && v !== "0px" && v !== "rgba(0, 0, 0, 0)") css[p] = v;
      });
      if (Object.keys(css).length) out.push({ selector: fullSel, css: css });
    });
    return out;
  }

  function propToCss(p) {
    return p.replace(/[A-Z]/g, function (c) { return "-" + c.toLowerCase(); });
  }

  function collectInteractive(root) {
    var r = { inputs: 0, buttons: 0, links: 0, sliders: 0, switches: 0, details: [] };
    var els = root.querySelectorAll("input,button,select,textarea,a,[role]");
    Array.prototype.forEach.call(els, function (el) {
      var tag = el.tagName.toLowerCase();
      var role = el.getAttribute("role") || "";
      var type = (el.getAttribute("type") || "").toLowerCase();
      var label = (el.getAttribute("aria-label") || el.getAttribute("placeholder") ||
        (el.textContent || "").trim().slice(0, 24) || "").trim();
      var interaction = null;

      if (tag === "a") { r.links++; interaction = "link→button"; }
      else if (tag === "button" || role === "button") { r.buttons++; interaction = "button"; }
      else if (tag === "select" || role === "combobox") { r.inputs++; interaction = "dropdown/combobox"; }
      else if (tag === "textarea" || tag === "input") {
        if (type === "range" || role === "slider") { r.sliders++; interaction = "slider"; }
        else if (type === "radio") { r.inputs++; interaction = "input(radio)"; }
        else if (type === "checkbox" || role === "switch") { r.switches++; interaction = "switch/checkbox"; }
        else { r.inputs++; interaction = "input(" + (type || "text") + ")"; }
      } else if (role === "slider") { r.sliders++; interaction = "slider"; }
      else if (role === "switch") { r.switches++; interaction = "switch"; }
      if (interaction && r.details.length < 20) {
        r.details.push({ tag: tag, role: role, type: type, label: label, interaction: interaction });
      }
    });
    return r;
  }

  // Collect original stylesheet rules (preserves @media / :hover — the thing
  // getComputedStyle cannot give). Cross-domain sheets throw on cssRules access.
  function collectRules(root) {
    var rootClasses = {};
    // Include the root element's OWN id/classes (querySelectorAll excludes self).
    if (root.id) rootClasses["#" + root.id] = true;
    (root.getAttribute("class") || "").split(/\s+/).forEach(function (c) { if (c) rootClasses["." + c] = true; });
    Array.prototype.forEach.call(root.querySelectorAll("[class],[id]"), function (el) {
      if (el.id) rootClasses["#" + el.id] = true;
      (el.getAttribute("class") || "").split(/\s+/).forEach(function (c) { if (c) rootClasses["." + c] = true; });
    });
    function touches(selectorText) {
      if (!selectorText) return false;
      for (var k in rootClasses) { if (selectorText.indexOf(k) >= 0) return true; }
      return selectorText.indexOf(root.tagName.toLowerCase()) >= 0;
    }
    function clip(t) { t = t.replace(/\s+/g, " ").trim(); return t.length > MAX_RULE_CHARS ? t.slice(0, MAX_RULE_CHARS) + " …" : t; }

    // State pseudo-classes / pseudo-elements / aria attribute selectors.
    // NOTE: match a literal "[aria-" (\[aria-), NOT the character class [aria-].
    var STATE_RE = /(:hover|:focus|:focus-visible|:focus-within|:active|:disabled|:checked|\[aria-|::placeholder|::before|::after)/;
    var responsive = [], state = [], base = [];
    var baseSeen = {};
    var total = 0, readable = 0, blocked = 0;
    var sheets = document.styleSheets;
    total = sheets.length;
    for (var i = 0; i < sheets.length; i++) {
      var rules;
      try { rules = sheets[i].cssRules; readable++; }
      catch (e) { blocked++; continue; } // cross-origin CORS
      if (!rules) continue;
      for (var j = 0; j < rules.length; j++) {
        var rule = rules[j];
        if (rule.type === CSSRule.MEDIA_RULE) {
          var media = "@media " + rule.media.mediaText;
          var inner = [];
          for (var k = 0; k < rule.cssRules.length; k++) {
            var rr = rule.cssRules[k];
            if (rr.selectorText && touches(rr.selectorText)) inner.push(clip(rr.cssText));
          }
          if (inner.length && responsive.length < 30) {
            responsive.push({ media: media, cssText: inner.join("\n") });
          }
        } else if (rule.selectorText && touches(rule.selectorText)) {
          // Original (non-computed) rules keep var()/clamp()/minmax() live values —
          // far more useful for replication than getComputedStyle dead pixels.
          if (!baseSeen[rule.selectorText] && base.length < 60) {
            baseSeen[rule.selectorText] = true;
            base.push(clip(rule.cssText));
          }
          if (STATE_RE.test(rule.selectorText) && state.length < 40) {
            state.push({ selector: rule.selectorText, cssText: clip(rule.style.cssText || rule.cssText) });
          }
        }
      }
    }
    return { responsiveRules: responsive, stateRules: state, baseRules: base,
             stylesheets: { total: total, readable: readable, blocked: blocked } };
  }

  window.__zhenHarvest = function (selector) {
    var root = null;
    try { root = document.querySelector(selector); } catch (e) { return { error: "invalid selector: " + e.message }; }
    if (!root) return { error: "selector matched no element: " + selector };

    var nodeCount = root.querySelectorAll("*").length + 1;
    // Return the FULL live DOM; sanitization + boundary-safe truncation happen
    // Node-side (sanitizeDomString), so a cut can never leak a half-attribute.
    var rawDom = root.outerHTML || "";
    var domTruncated = rawDom.length > MAX_HTML_CHARS;

    var rect = root.getBoundingClientRect();
    var rules = collectRules(root);

    return {
      selector: selector,
      tag: root.tagName.toLowerCase(),
      rect: { width: rect.width, height: rect.height },
      nodeCount: nodeCount,
      domTruncated: domTruncated,
      dom: rawDom,
      visualCss: collectVisual(root, selector),
      interactive: collectInteractive(root),
      responsiveRules: rules.responsiveRules,
      stateRules: rules.stateRules,
      baseRules: rules.baseRules,
      stylesheets: rules.stylesheets,
    };
  };
})();
