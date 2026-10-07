// Built-in plugin: search Notion (app.notion.com) from a driven tab.
//
//   browser-session-ctl --tab <id> plugin.notion search "FOO-1234"
//   browser-session-ctl --tab <id> plugin.notion open "FOO-1234" 0
//   browser-session-ctl --tab <id> plugin.notion close
//
// Like the jupyter-notebook plugin, this has no public JS API to call into —
// Notion's search is the same "Search or ask" combobox a person opens with
// the sidebar button (or Cmd/Ctrl+K), so this drives that real UI: click it
// open, type into its <input role="combobox">, read back the <div
// role="option"> results (each wrapped in an <a href> to the page), and
// optionally click one to navigate.
class Plugin {
  help() {
    return {
      namespace: "notion",
      methods: {
        help: "Show this message.",
        search:
          "search <query...> — open Notion search (if not already open) and search for <query>. Returns matching pages: title, breadcrumb, url.",
        open:
          "open <query...> [--index N] — search for <query> and click the Nth result (default 0), navigating to that page.",
        results: "results — re-read whatever search results are currently showing, without changing the query.",
        close: "close — close the search overlay.",
        comments:
          "comments — on the currently open page, open (or reuse) its Comments panel and return every comment as {thread, author, authorUrl, timestamp, body}.",
        closeComments: "closeComments — close the Comments panel.",
      },
    };
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  fireClick(target) {
    const rect = target.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
    };
    target.dispatchEvent(new PointerEvent("pointerdown", opts));
    target.dispatchEvent(new MouseEvent("mousedown", opts));
    target.dispatchEvent(new PointerEvent("pointerup", opts));
    target.dispatchEvent(new MouseEvent("mouseup", opts));
    target.dispatchEvent(new MouseEvent("click", opts));
  }

  searchInput() {
    return document.querySelector('input[role="combobox"]');
  }

  searchTrigger() {
    return document.querySelector('[role="button"][aria-label="Search or ask"]');
  }

  // Opens the search overlay if it isn't already, i.e. if its <input
  // role="combobox"> isn't in the DOM yet.
  async ensureOpen() {
    if (this.searchInput()) return;
    const trigger = this.searchTrigger();
    if (!trigger) throw new Error('Could not find the "Search or ask" sidebar button on this page');
    this.fireClick(trigger);
    for (let i = 0; i < 20; i += 1) {
      await this.sleep(100);
      if (this.searchInput()) return;
    }
    throw new Error("Search overlay did not open after clicking its trigger");
  }

  // A real, framework-controlled <input>, same dance as jupyter-notebook's
  // setCellType: the native value setter plus a real input event so
  // Notion's own listeners (which drive the debounced search) see the change.
  async typeQuery(text) {
    const input = this.searchInput();
    if (!input) throw new Error("Search input not found (overlay not open?)");
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  optionEls() {
    const listbox = document.querySelector('[role="listbox"]');
    return listbox ? [...listbox.querySelectorAll('[role="option"]')] : [];
  }

  // Each result option's markup is icon / text-block / actions, and the
  // text-block itself is exactly two divs: title, then a "breadcrumb •
  // author • edited ..." meta line with no whitespace between them in
  // textContent. Rather than hardcode that nesting depth (brittle against
  // Notion's own markup churn), find the div that actually has that
  // two-children shape and read its children directly.
  parseOption(el) {
    // A "Most viewed" badge is itself a 2-children div (icon + label), so
    // require the meta (second) child to actually look like "breadcrumb •
    // author • edited ..." rather than matching the first 2-children div
    // in document order.
    const textBlock = [...el.querySelectorAll("div")].find(
      (d) => d.children.length === 2 && /•/.test(d.children[1].textContent || "")
    );
    const link = el.closest("a[href]");
    if (!textBlock) {
      return { title: (el.textContent || "").trim(), breadcrumb: null, url: link ? link.href : null };
    }
    const title = (textBlock.children[0].textContent || "").trim();
    const meta = (textBlock.children[1].textContent || "").trim();
    const [breadcrumb] = meta.split("•"); // "•"
    return { title, breadcrumb: breadcrumb ? breadcrumb.trim() : null, meta, url: link ? link.href : null };
  }

  // Debounced search: poll until the result set stops changing instead of a
  // fixed sleep, so a slow query still returns real results and a fast one
  // doesn't waste time.
  async waitForResults(previousQuery) {
    let last = null;
    for (let i = 0; i < 30; i += 1) {
      await this.sleep(150);
      const input = this.searchInput();
      if (!input || input.value !== previousQuery) continue; // still catching up to what we typed
      const current = JSON.stringify(this.optionEls().map((el) => el.textContent));
      if (current === last) return;
      last = current;
    }
  }

  async search(...queryParts) {
    const query = queryParts.join(" ");
    if (!query) throw new Error("search requires a query, e.g. plugin.notion search INTEG-1565");
    await this.ensureOpen();
    await this.typeQuery(query);
    await this.waitForResults(query);
    return this.optionEls().map((el) => this.parseOption(el));
  }

  results() {
    return this.optionEls().map((el) => this.parseOption(el));
  }

  async open(...args) {
    let index = 0;
    const queryParts = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "--index") {
        index = Number(args[i + 1]);
        i += 1;
      } else {
        queryParts.push(args[i]);
      }
    }
    const found = await this.search(...queryParts);
    const els = this.optionEls();
    const el = els[index];
    if (!el) throw new Error(`No result at index ${index} (got ${els.length} result(s))`);
    const target = found[index];
    // Click the option itself, not its ancestor <a> — Notion's router
    // listens for the click on the row (React's synthetic event system),
    // and a synthetic click dispatched straight on the <a> doesn't reach it.
    this.fireClick(el);
    // The search overlay closes itself once the click navigates, so that's
    // a simple, reliable "done" signal instead of guessing a fixed delay.
    for (let i = 0; i < 20; i += 1) {
      await this.sleep(150);
      if (!this.searchInput()) break;
    }
    return { navigatedTo: target, url: location.href };
  }

  close() {
    const input = this.searchInput();
    if (!input) return { wasOpen: false };
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return { wasOpen: true };
  }

  commentsButton() {
    return document.querySelector(".notion-topbar-comments-button");
  }

  commentsScroller() {
    return document.querySelector(".notion-update-sidebar-tab-comments-comments-scroller");
  }

  // The topbar "Comments" button first opens a small popover with just the
  // latest message and a "See all" button — the full per-message list (the
  // "...-comments-scroller", with a reply box) only renders after that's
  // clicked too, so this drives both steps like a person would.
  async ensureCommentsOpen() {
    if (this.commentsScroller()) return;
    const btn = this.commentsButton();
    if (!btn) {
      throw new Error('Could not find the "Comments" topbar button — is this a page, not a database view?');
    }
    this.fireClick(btn);
    for (let i = 0; i < 20; i += 1) {
      await this.sleep(150);
      if (this.commentsScroller()) return;
      // "See all" is a div[role="button"], not a real <button> — same as
      // the search trigger, Notion's own buttons are rarely native ones.
      const seeAll = [...document.querySelectorAll('[role="button"], button')].find(
        (b) => /^see all$/i.test((b.textContent || "").trim())
      );
      if (seeAll) {
        this.fireClick(seeAll);
        await this.sleep(150);
        if (this.commentsScroller()) return;
      }
    }
    // A page with zero comments never grows a scroller (nothing to scroll)
    // but still shows the empty reply compose box — that's still "opened".
    if (!document.querySelector(".notion-discussion-input")) {
      throw new Error("Comments panel did not open after clicking its topbar button");
    }
  }

  // Every non-empty leaf element inside a comment row, in document order:
  // typically [avatarInitial?, authorName, timestamp, ...quotedContext?,
  // ...bodyText]. Reading leaves instead of the row's flattened textContent
  // is what makes it possible to tell "14h" (a whole leaf) apart from a
  // message that happens to start with a letter right after it.
  leafTexts(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => (n.children.length === 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    let n = walker.nextNode();
    while (n) {
      const t = (n.textContent || "").trim();
      if (t) out.push(t);
      n = walker.nextNode();
    }
    return out;
  }

  // Walk up from an author <a> only as long as the ancestor still contains
  // just that one author link — one level further and it starts spanning
  // the next comment too, so that's the row boundary for this comment.
  commentRow(authorLink) {
    let el = authorLink;
    let candidate = authorLink.parentElement;
    while (candidate) {
      if (candidate.querySelectorAll('a[href*="/profiles/"]').length > 1) break;
      el = candidate;
      candidate = candidate.parentElement;
    }
    return el;
  }

  // Recent comments show a relative time ("14h", "Yesterday") as its own
  // leaf; older ones switch to an absolute date ("Mar 16", optionally with
  // "(edited)" or a trailing mention glued on) — and for some older
  // comments that date isn't even its own leaf, just text stuck to the
  // front of the first body leaf, so this checks both shapes.
  splitTimestamp(leaves) {
    const RELATIVE_RE = /^(\d+[smhdw]|\d+mo|Just now|Yesterday)$/i;
    const ABSOLUTE_LEAF_RE = /^[A-Z][a-z]{2} \d{1,2}(,? \d{4})?( ?\(edited\))?( ?@)?$/;
    const ABSOLUTE_PREFIX_RE = /^([A-Z][a-z]{2} \d{1,2}(,? \d{4})?)\s*/;
    if (!leaves.length) return { timestamp: null, rest: leaves };
    if (RELATIVE_RE.test(leaves[0]) || ABSOLUTE_LEAF_RE.test(leaves[0])) {
      return { timestamp: leaves[0], rest: leaves.slice(1) };
    }
    const m = leaves[0].match(ABSOLUTE_PREFIX_RE);
    if (m) {
      const remainder = leaves[0].slice(m[0].length);
      return { timestamp: m[1], rest: remainder ? [remainder, ...leaves.slice(1)] : leaves.slice(1) };
    }
    return { timestamp: null, rest: leaves };
  }

  parseCommentRow(authorLink, threadIndex) {
    const author = authorLink.textContent.trim();
    const leaves = this.leafTexts(this.commentRow(authorLink));
    const authorIdx = leaves.indexOf(author);
    const afterAuthor = authorIdx === -1 ? leaves : leaves.slice(authorIdx + 1);
    const { timestamp, rest } = this.splitTimestamp(afterAuthor);
    return {
      thread: threadIndex,
      author,
      authorUrl: authorLink.href,
      timestamp,
      // If this comment quotes the anchor text it's attached to, that quote
      // is its own leaf right before the real message with no way to tell
      // them apart from text alone — both end up joined into body here.
      body: rest.join(" ").trim(),
    };
  }

  async comments() {
    await this.ensureCommentsOpen();
    const threads = [...document.querySelectorAll(".notion-update-sidebar-tab-comments-discussion-item")];
    return threads.flatMap((thread, threadIndex) =>
      [...thread.querySelectorAll('a[href*="/profiles/"]')].map((a) => this.parseCommentRow(a, threadIndex))
    );
  }

  closeComments() {
    const btn = this.commentsButton();
    if (!this.commentsScroller()) return { wasOpen: false };
    if (btn) this.fireClick(btn);
    return { wasOpen: true };
  }
}
