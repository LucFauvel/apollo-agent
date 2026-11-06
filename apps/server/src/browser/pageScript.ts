/**
 * Helpers installed in each page as `window.__apollo`. Kept as a plain string
 * (not a stringified function) so bundlers cannot rewrite it.
 *
 * `snapshot()` renders the page as an indented outline: headings, text,
 * landmarks and every interactive element, which gets a ref (`e12`). Refs map
 * to elements in `refs`, so they work in open shadow roots and same-origin
 * frames, and they are replaced by the next snapshot.
 */
export const PAGE_SCRIPT = String.raw`
(() => {
  if (window.__apollo && window.__apollo.version === 1) return;
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK"]);
  const LANDMARK = { NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo", ASIDE: "complementary", FORM: "form", DIALOG: "dialog", TABLE: "table", UL: "list", OL: "list", SECTION: "region" };
  const clean = (s, max) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return max && t.length > max ? t.slice(0, max - 1) + "…" : t;
  };
  const quote = (s) => JSON.stringify(s);
  const visible = (el) => {
    const view = el.ownerDocument.defaultView;
    const style = view.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (Number(style.opacity) === 0 && el.tagName !== "INPUT") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0 || style.display === "contents";
  };
  const textOf = (id, doc) => {
    const el = doc.getElementById(id);
    return el ? clean(el.innerText || el.textContent, 120) : "";
  };
  const nameOf = (el) => {
    const doc = el.ownerDocument;
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria, 120);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => textOf(id, doc)).filter(Boolean).join(" ");
      if (t) return t;
    }
    if (el.id) {
      try {
        const label = doc.querySelector("label[for=" + quote(el.id) + "]");
        if (label) return clean(label.innerText || label.textContent, 120);
      } catch {}
    }
    const wrap = el.closest && el.closest("label");
    if (wrap && wrap !== el) return clean(wrap.innerText || wrap.textContent, 120);
    if (el.tagName === "IMG") return clean(el.getAttribute("alt"), 120);
    const own = ["BUTTON", "A", "SUMMARY", "OPTION"].includes(el.tagName) || el.getAttribute("role") ? clean(el.innerText || el.textContent, 120) : "";
    return own || clean(el.getAttribute("placeholder") || el.getAttribute("title") || (el.tagName === "INPUT" && el.type === "submit" ? el.value : ""), 120);
  };
  const roleOf = (el) => {
    const role = el.getAttribute("role");
    if (role) return role;
    const tag = el.tagName;
    if (tag === "A") return el.hasAttribute("href") ? "link" : null;
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return el.multiple ? "listbox" : "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (t === "hidden") return null;
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "checkbox" || t === "radio") return t;
      if (t === "range") return "slider";
      if (t === "file") return "file input";
      if (["search", "email", "url", "tel", "password", "number", "text", "date", "time", "datetime-local", "month", "week", "color"].includes(t)) return t === "text" ? "textbox" : t + " field";
      return "textbox";
    }
    if (el.isContentEditable && (el.parentElement == null || !el.parentElement.isContentEditable)) return "editable";
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "IMG") return el.getAttribute("alt") ? "img" : null;
    return null;
  };
  const INTERACTIVE = new Set(["link", "button", "combobox", "listbox", "textbox", "checkbox", "radio", "slider", "file input", "editable", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "searchbox", "spinbutton", "treeitem"]);
  const isInteractive = (el, role) =>
    (role && (INTERACTIVE.has(role) || role.endsWith(" field"))) ||
    (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1" && el.tagName !== "DIV" ? true : false) ||
    el.hasAttribute("onclick");

  const api = {
    version: 1,
    refs: new Map(),
    snapshot(maxChars) {
      api.refs = new Map();
      let count = 0;
      const lines = [];
      let size = 0;
      let truncated = false;
      const push = (depth, text) => {
        if (truncated) return;
        const line = "  ".repeat(Math.min(depth, 12)) + text;
        if (size + line.length > maxChars) {
          truncated = true;
          return;
        }
        lines.push(line);
        size += line.length + 1;
      };
      const walk = (node, depth) => {
        if (truncated) return;
        if (node.nodeType === 3) {
          const t = clean(node.textContent, 300);
          if (t) push(depth, t);
          return;
        }
        if (node.nodeType !== 1 && node.nodeType !== 11) return;
        if (node.nodeType === 1) {
          const el = node;
          if (SKIP.has(el.tagName)) return;
          if (el.getAttribute("aria-hidden") === "true") return;
          if (!visible(el)) return;
          const role = roleOf(el);
          if (role && isInteractive(el, role)) {
            const ref = "e" + ++count;
            api.refs.set(ref, el);
            const name = nameOf(el);
            let line = "- " + role + (name ? " " + quote(name) : "");
            if (el.tagName === "A" && el.getAttribute("href")) {
              const href = el.getAttribute("href");
              if (!href.startsWith("javascript:")) line += " → " + clean(href, 80);
            }
            if ("value" in el && el.tagName !== "BUTTON" && !["checkbox", "radio", "button", "submit"].includes(el.type)) {
              const v = el.type === "password" ? (el.value ? "(hidden)" : "") : el.tagName === "SELECT" ? clean(el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].text : el.value, 60) : clean(el.value, 80);
              if (v) line += " value=" + quote(v);
            }
            if (el.checked) line += " checked";
            if (el.disabled) line += " disabled";
            if (el.getAttribute("aria-expanded")) line += " expanded=" + el.getAttribute("aria-expanded");
            if (el.getAttribute("aria-selected") === "true") line += " selected";
            if (el.tagName === "SELECT") {
              const options = [...el.options].slice(0, 25).map((o) => clean(o.text, 40)).filter(Boolean);
              if (options.length) line += " options: " + options.map(quote).join(", ") + (el.options.length > 25 ? ", …" : "");
            }
            push(depth, line + " [ref=" + ref + "]");
            // Inputs have no meaningful children; links and buttons are named by theirs.
            return;
          }
          if (role === "heading") {
            push(depth, "#".repeat(Number(el.tagName[1]) || 2) + " " + clean(el.innerText || el.textContent, 200));
            return;
          }
          if (role === "img") {
            push(depth, "- img " + quote(nameOf(el)));
            return;
          }
          if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
            let doc = null;
            try {
              doc = el.contentDocument;
            } catch {}
            if (doc && doc.body) {
              push(depth, "- frame" + (el.title ? " " + quote(el.title) : ""));
              walk(doc.body, depth + 1);
            } else push(depth, "- frame (cross-origin) " + clean(el.src, 80));
            return;
          }
          const landmark = LANDMARK[el.tagName] || (el.getAttribute("role") && ["navigation", "main", "dialog", "alertdialog", "alert", "region", "tablist", "menu", "list"].includes(el.getAttribute("role")) ? el.getAttribute("role") : null);
          const childDepth = landmark ? depth + 1 : depth;
          if (landmark) {
            const name = el.getAttribute("aria-label") || "";
            push(depth, "- " + landmark + (name ? " " + quote(clean(name, 60)) : "") + ":");
          }
          if (el.shadowRoot) walk(el.shadowRoot, childDepth);
          for (const child of el.childNodes) walk(child, childDepth);
          return;
        }
        for (const child of node.childNodes) walk(child, depth);
      };
      walk(document.body || document.documentElement, 0);
      // Merge runs of short text lines at the same depth into one line.
      const merged = [];
      for (const line of lines) {
        const prev = merged[merged.length - 1];
        const indent = line.match(/^ */)[0];
        const isText = !/^ *(- |#)/.test(line);
        if (prev !== undefined && isText && prev.isText && prev.indent === indent && prev.text.length < 400) {
          prev.text += " " + line.trim();
        } else merged.push({ text: line, isText, indent });
      }
      return { url: location.href, title: document.title, text: merged.map((m) => m.text).join("\n"), truncated, refs: count };
    },
    resolve(ref) {
      const el = api.refs.get(ref);
      if (!el) throw new Error("unknown ref " + ref + ": take a new snapshot (refs change after each snapshot and navigation)");
      if (!el.isConnected) throw new Error("ref " + ref + " is no longer on the page: take a new snapshot");
      return el;
    },
    find(ref, selector) {
      if (ref) return api.resolve(ref);
      const el = document.querySelector(selector);
      if (!el) throw new Error("no element matches " + selector);
      return el;
    },
    /** Scrolls the element into view and returns its center in top-level viewport pixels. */
    point(ref, selector) {
      const el = api.find(ref, selector);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      let x = r.left + r.width / 2;
      let y = r.top + r.height / 2;
      let win = el.ownerDocument.defaultView;
      while (win && win.frameElement) {
        const fr = win.frameElement.getBoundingClientRect();
        x += fr.left;
        y += fr.top;
        win = win.parent;
      }
      let covered = null;
      if (el.ownerDocument === document) {
        const top = document.elementFromPoint(x, y);
        if (top && top !== el && !el.contains(top) && !top.contains(el)) covered = top.tagName.toLowerCase() + (top.id ? "#" + top.id : "");
      }
      return { x, y, width: r.width, height: r.height, covered };
    },
    focus(ref, selector, clear) {
      const el = api.find(ref, selector);
      el.focus();
      if (clear) {
        if ("select" in el && typeof el.select === "function") el.select();
        else if (el.isContentEditable) el.ownerDocument.execCommand("selectAll");
      }
      return true;
    },
    select(ref, selector, values) {
      const el = api.find(ref, selector);
      if (el.tagName !== "SELECT") throw new Error("not a <select>: click a custom dropdown open, then click the option");
      const wanted = values.map((v) => String(v).toLowerCase());
      let matched = 0;
      for (const option of el.options) {
        const hit = wanted.includes(option.value.toLowerCase()) || wanted.includes(clean(option.text).toLowerCase());
        if (el.multiple) option.selected = hit;
        else if (hit && !matched) el.value = option.value;
        if (hit) matched++;
      }
      if (!matched) throw new Error("no option matches " + values.join(", "));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return matched;
    },
    scroll(ref, selector, dx, dy) {
      const el = api.find(ref, selector);
      el.scrollBy({ left: dx, top: dy, behavior: "instant" });
      return true;
    },
    check(text, selector, urlIncludes) {
      if (urlIncludes && !location.href.includes(urlIncludes)) return false;
      if (selector) {
        const el = document.querySelector(selector);
        if (!el || !visible(el)) return false;
      }
      if (text && !(document.body && document.body.innerText.includes(text))) return false;
      return true;
    },
  };
  Object.defineProperty(window, "__apollo", { value: api, configurable: true });
})();
`;
