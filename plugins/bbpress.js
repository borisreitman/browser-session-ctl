// Built-in plugin: read a bbPress forum thread (topic + replies) as Markdown.
//
//   browser-session-ctl --tab <id> plugin.bbpress thread > thread.json
//
// Returns the whole thread as one JSON object: {title, url, pages, count, posts[]}.
//
// Read-only. Targets stock bbPress markup (.bbp-topic-content / .bbp-reply-content
// inside .type-topic / .type-reply). A themed site subclasses this and overrides
// `selectors()` (see plugins/hbl.js, which has `// @requires bbpress`).
//
// Pagination: do NOT trust the ".bbp-pagination" links on an HBL topic page. They
// describe the forum's topic list (143 pages), not the replies. On a one-page
// thread, /page/2/ answers 200 with the same replies as page 1. So `thread`
// fetches page 1, 2, 3, ... and stops at the first page that adds no new post id.
//
// Page-side only: nothing is written to disk. Author emails that
// HBL prints in the card header are deliberately not captured.
class Plugin {
  help() {
    return {
      namespace: "bbpress",
      methods: {
        help: "Show this message.",
        status: "status — url, thread base url, title and how many posts this page shows.",
        posts: "posts — the posts rendered on THIS page only: {title, url, count, posts[]}.",
        thread:
          "thread [--max-pages N] [--delay MS] — the whole thread: fetches page 1, 2, … from the thread's base url (same-origin, your cookies) until a page adds no new post. Returns {title, url, pages, count, posts:[{seq, id, kind: topic|reply, author, date, iso, permalink, page, markdown}]} in thread order.",
      },
    };
  }

  flags(args) {
    const flags = {};
    for (let i = 0; i < args.length; i += 1) {
      if (String(args[i]).startsWith("--")) { flags[String(args[i]).slice(2)] = String(args[i + 1] || ""); i += 1; }
    }
    return flags;
  }

  baseUrl() {
    return location.href.replace(/[?#].*$/, "").replace(/\/page\/\d+\/?$/, "/");
  }

  clean(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  // Where a post's author, date and the topic title live. Subclasses override this;
  // each value is a CSS selector list searched inside the post's card.
  selectors() {
    return {
      author: ".bbp-author-name",
      date: ".bbp-reply-post-date, .bbp-topic-post-date",
      title: ".bbp-topic-title, .bbp-topic-permalink",
    };
  }

  // Extra fields a subclass wants on every post. Called with (card, head, doc).
  extra() {
    return {};
  }

  threadTitle(doc) {
    const t = doc.querySelector(this.selectors().title);
    if (t && this.clean(t.textContent)) return this.clean(t.textContent);
    const h = doc.querySelector("h1");
    if (h && this.clean(h.textContent)) return this.clean(h.textContent);
    return this.clean(doc.title).replace(/^Topic:\s*/i, "").replace(/\s+[–-]\s+Page \d+.*$/, "").replace(/\s+[–-]\s+[^–-]+$/, "");
  }

  // "July 30, 2021 at 10:50 am" or "07/30/21 @ 10:50am EDT" -> "2021-07-30 10:50" (site-local time, no zone).
  iso(raw) {
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const pad = (n) => String(n).padStart(2, "0");
    let y, mo, d;
    let m = raw.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
    if (m && months.indexOf(m[1].toLowerCase()) >= 0) { mo = months.indexOf(m[1].toLowerCase()) + 1; d = +m[2]; y = +m[3]; }
    else if ((m = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/))) { mo = +m[1]; d = +m[2]; y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; }
    else return null;
    let out = `${y}-${pad(mo)}-${pad(d)}`;
    const t = raw.match(/(\d{1,2}):(\d{2})\s*([ap]m)?/i);
    if (t) {
      let h = +t[1];
      if (t[3]) { h = h % 12 + (t[3].toLowerCase() === "pm" ? 12 : 0); }
      out += ` ${pad(h)}:${t[2]}`;
    }
    return out;
  }

  // --- DOM -> Markdown -------------------------------------------------------

  tidy(s) {
    return s.replace(/\n[ \t]+(?=\n|$)/g, "\n").replace(/\n[ ]+(?=\S)/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/^\s+|\s+$/g, "");
  }

  md(node) {
    if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, " ");
    if (node.nodeType !== 1) return "";
    const tag = node.tagName.toLowerCase();
    const kids = () => [...node.childNodes].map((n) => this.md(n)).join("");
    switch (tag) {
      case "script": case "style": case "noscript": case "form": case "button": return "";
      case "br": return "  \n";
      case "hr": return "\n\n---\n\n";
      case "p": case "div": case "section": case "article": case "figure": return `\n\n${kids()}\n\n`;
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        return `\n\n${"#".repeat(+tag[1])} ${this.clean(kids())}\n\n`;
      case "strong": case "b": { const t = kids().trim(); return t ? `**${t}**` : ""; }
      case "em": case "i": case "cite": { const t = kids().trim(); return t ? `*${t}*` : ""; }
      case "u": case "span": case "small": case "sup": case "sub": case "font": return kids();
      case "code": return node.closest("pre") ? node.textContent : `\`${node.textContent}\``;
      case "pre": return `\n\n\`\`\`\n${node.textContent.replace(/\n$/, "")}\n\`\`\`\n\n`;
      case "a": {
        const href = node.href || node.getAttribute("href") || "";
        const text = kids().trim();
        if (!href || href.startsWith("javascript:")) return text;
        if (!text || text === href) return `<${href}>`;
        return `[${text}](${href})`;
      }
      case "img": {
        const alt = node.getAttribute("alt") || "";
        if (node.classList.contains("bbcode_smiley") || /smil|emoji/i.test(node.className)) return alt;
        const src = node.currentSrc || node.src || node.getAttribute("src") || "";
        return src ? `![${alt}](${src})` : "";
      }
      case "iframe": { const s = node.src || ""; return s ? `\n\n<${s}>\n\n` : ""; }
      case "blockquote": {
        const inner = this.tidy(kids());
        return `\n\n${inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")}\n\n`;
      }
      case "ul": case "ol": {
        let n = 0;
        const items = [...node.children].filter((c) => c.tagName.toLowerCase() === "li").map((li) => {
          n += 1;
          const bullet = tag === "ol" ? `${n}. ` : "- ";
          const inner = this.tidy(this.md(li)).split("\n");
          return bullet + inner.map((l, i) => (i ? " ".repeat(bullet.length) + l : l)).join("\n");
        });
        return `\n\n${items.join("\n")}\n\n`;
      }
      default: return kids();
    }
  }

  body(el) {
    const c = el.cloneNode(true);
    for (const x of c.querySelectorAll(".gdbbx-thanks-wrapper, .gdbbx-footer-meta, .gdbbx-admin-links, .bbp-admin-links, .printomatic, .bbp-meta, script, style")) x.remove();
    return this.tidy(this.md(c));
  }

  // --- extraction ------------------------------------------------------------

  parse(doc) {
    const posts = [];
    const seen = new Set();
    const sel = this.selectors();
    for (const body of doc.querySelectorAll(".bbp-topic-content, .bbp-reply-content")) {
      const card = body.closest("[class*='type-reply'], [class*='type-topic']") || body.parentElement;
      const id = (String(card.className).match(/\bpost-(\d+)\b/) || [])[1] || (String(card.id).match(/\d+/) || [])[0];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const kind = body.classList.contains("bbp-topic-content") ? "topic" : "reply";
      const head = doc.getElementById(`post-${id}`) || card;
      const pick = (root, sel) => { const e = root.querySelector(sel); return e ? this.clean(e.textContent) : ""; };
      const author = pick(card, sel.author) || pick(head, sel.author);
      const date = pick(card, sel.date) || pick(head, sel.date);
      const link = head.querySelector("a.bbp-reply-permalink, a.bbp-topic-permalink");
      posts.push({
        id,
        kind,
        author,
        date,
        iso: this.iso(date),
        permalink: link ? link.href : `${this.baseUrl()}#post-${id}`,
        markdown: this.body(body),
        ...this.extra(card, head, doc),
      });
    }
    return posts;
  }

  status() {
    return { url: location.href, base: this.baseUrl(), title: this.threadTitle(document), posts: this.parse(document).length };
  }

  posts() {
    const posts = this.parse(document).map((p, i) => ({ seq: i + 1, ...p }));
    return { title: this.threadTitle(document), url: location.href, count: posts.length, posts };
  }

  async thread(...args) {
    const flags = this.flags(args);
    const maxPages = flags["max-pages"] ? Number(flags["max-pages"]) : 200;
    const delay = flags.delay ? Number(flags.delay) : 400;
    const base = this.baseUrl();
    const byId = new Map();
    let title = this.threadTitle(document);
    let pages = 0;
    for (let p = 1; p <= maxPages; p += 1) {
      const url = p === 1 ? base : `${base}page/${p}/`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) break;
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      if (p === 1) title = this.threadTitle(doc) || title;
      let added = 0;
      for (const post of this.parse(doc)) {
        if (byId.has(post.id)) continue;
        byId.set(post.id, { ...post, page: p });
        added += 1;
      }
      if (!added) break;
      pages = p;
      await bsc.sleep(delay);
    }
    const posts = [...byId.values()].map((p, i) => ({ seq: i + 1, ...p }));
    return { title, url: base, pages, count: posts.length, posts };
  }
}
