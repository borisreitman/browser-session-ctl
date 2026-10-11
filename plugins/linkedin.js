// Built-in plugin: search LinkedIn people (www.linkedin.com) from a driven tab.
//
//   browser-session-ctl --tab <id> plugin.linkedin search url "cto fintech" --network 2,3
//   browser-session-ctl --tab <id> nav "<url printed by `search url`>"
//   browser-session-ctl --tab <id> plugin.linkedin search results
//
// LinkedIn has no public JS API and its class names are generated, so this
// works the way a person does: people search is addressed entirely by URL
// (/search/results/people/?keywords=...), and the result cards are read back
// from the DOM using only stable structure: each result is a role="listitem"
// whose name <p> holds the /in/ profile link and the " • 2nd" degree badge,
// followed by a headline <p> and a location <p>.
//
// Everything is grouped behind subcommands so more areas can be added later:
//   search url|go|results|next   people search
//   page   list|select|current   pick which LinkedIn Page you act for
//   post   open|draft|status     draft a post as the selected Page (never publishes)
// Navigating unloads the page (and this plugin instance), so `search go` only
// schedules the navigation; run `search results` afterwards, or use the
// `linkedin-people` wrapper which does both.
class Plugin {
  help() {
    return {
      namespace: "linkedin",
      methods: {
        help: "Show this message.",
        search:
          "search <url|go|results|next> ... — people search. url/go take: <keywords...> [--title T] [--company C] [--school S] [--first F] [--last L] [--network 1,2,3] [--page N]. url builds the URL only; go navigates this tab (page unloads); results [--limit N] waits for and returns the cards (name, degree, headline, location, url, mutual, extra); next goes to the next results page.",
        page:
          "page <list|select|current> — Pages you administer. list reads them from the Me menu ({id, name}); select <name-or-id> remembers one for this tab (sessionStorage) and opens its admin dashboard; current shows the selection.",
        post:
          "post <open|draft|status> — post as the selected Page. open navigates to its composer; draft <text...> types the text into the open composer and stops (it does NOT click Post); status shows who the composer posts as and its current text.",
        status: "status — what page this is: url, whether it is a people search, signed in, result count.",
      },
    };
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  clean(text) {
    return String(text || "").replace(/[‎‏]/g, "").replace(/\s+/g, " ").trim();
  }

  // Parse `foo bar --title CTO --network 2,3 --page 2` into { keywords, flags }.
  parseArgs(args) {
    const flags = {};
    const words = [];
    const known = new Set(["title", "company", "school", "first", "last", "network", "page", "limit"]);
    for (let i = 0; i < args.length; i += 1) {
      const a = String(args[i]);
      if (a.startsWith("--") && known.has(a.slice(2))) {
        flags[a.slice(2)] = String(args[i + 1] === undefined ? "" : args[i + 1]);
        i += 1;
      } else {
        words.push(a);
      }
    }
    return { keywords: words.join(" "), flags };
  }

  buildUrl(args) {
    const { keywords, flags } = this.parseArgs(args);
    const params = new URLSearchParams();
    if (keywords) params.set("keywords", keywords);
    if (flags.title) params.set("title", flags.title);
    if (flags.company) params.set("company", flags.company);
    if (flags.school) params.set("school", flags.school);
    if (flags.first) params.set("firstName", flags.first);
    if (flags.last) params.set("lastName", flags.last);
    if (flags.network) {
      const codes = flags.network
        .split(/[,\s]+/)
        .map((n) => ({ 1: "F", 2: "S", 3: "O" })[n.replace(/\D/g, "")])
        .filter(Boolean);
      if (codes.length) params.set("network", JSON.stringify(codes));
    }
    if (!params.toString()) throw new Error("Give at least keywords or one of --title/--company/--school/--first/--last");
    params.set("origin", "FACETED_SEARCH");
    if (flags.page && Number(flags.page) > 1) params.set("page", String(Number(flags.page)));
    return `https://www.linkedin.com/search/results/people/?${params}`;
  }

  // plugin.linkedin search <url|go|results|next> ...
  async search(action, ...args) {
    const actions = { url: "searchUrl", go: "searchGo", results: "searchResults", next: "searchNext" };
    if (!actions[action]) throw new Error(`search needs a subcommand: ${Object.keys(actions).join(", ")} (got ${action || "none"})`);
    return this[actions[action]](...args);
  }

  searchUrl(...args) {
    return { url: this.buildUrl(args) };
  }

  searchGo(...args) {
    const url = this.buildUrl(args);
    setTimeout(() => location.assign(url), 50);
    return { navigating: true, url };
  }

  searchNext() {
    const u = new URL(location.href);
    if (!u.pathname.startsWith("/search/results/people")) throw new Error("Not on a LinkedIn people search page");
    const page = Number(u.searchParams.get("page") || 1) + 1;
    u.searchParams.set("page", String(page));
    setTimeout(() => location.assign(u.href), 50);
    return { navigating: true, url: u.href, page };
  }

  // ---- Pages (company admin) -------------------------------------------

  pageStore(value) {
    const key = "bsc-linkedin-page";
    if (value === undefined) {
      try {
        return JSON.parse(sessionStorage.getItem(key));
      } catch (e) {
        return null;
      }
    }
    sessionStorage.setItem(key, JSON.stringify(value));
    return value;
  }

  // plugin.linkedin page <list|select|current> ...
  async page(action, ...args) {
    if (action === "list") return { pages: await this.pageList() };
    if (action === "select") return this.pageSelect(args.join(" "));
    if (action === "current") return { page: this.pageStore() };
    throw new Error(`page needs a subcommand: list, select, current (got ${action || "none"})`);
  }

  meButton() {
    return [...document.querySelectorAll("button[aria-expanded]")].find((b) => /^\s*Me\s*$/.test(this.clean(b.textContent)));
  }

  adminLinks() {
    const found = new Map();
    for (const a of document.querySelectorAll('a[href*="/company/"]')) {
      const m = a.href.match(/\/company\/(\d+)\/admin\/?$/);
      const name = this.clean(a.textContent).replace(/^Company:\s*/, "");
      if (m && name && !found.has(m[1])) found.set(m[1], { id: m[1], name });
    }
    return [...found.values()];
  }

  // The "My pages" entries live in the Me dropdown; open it, read, close it.
  async pageList() {
    let pages = this.adminLinks();
    if (pages.length) return pages;
    const me = this.meButton();
    if (!me) throw new Error("Could not find the Me menu; open a normal linkedin.com page first");
    const wasOpen = me.getAttribute("aria-expanded") === "true";
    if (!wasOpen) bsc.fireClick(me);
    pages = (await bsc.waitFor(() => (this.adminLinks().length ? this.adminLinks() : null), 20, 250)) || [];
    if (!wasOpen) bsc.fireClick(me);
    return pages;
  }

  async pageSelect(query) {
    if (!query) throw new Error("page select needs a page name or id");
    const pages = await this.pageList();
    const q = query.toLowerCase();
    const hits = pages.filter((p) => p.id === query || p.name.toLowerCase() === q);
    const matches = hits.length ? hits : pages.filter((p) => p.name.toLowerCase().includes(q));
    if (matches.length !== 1) {
      throw new Error(
        `${matches.length ? "Ambiguous" : "No"} page matches "${query}"; you administer: ${pages.map((p) => p.name).join(", ") || "(none found)"}`
      );
    }
    const page = this.pageStore(matches[0]);
    const url = `https://www.linkedin.com/company/${page.id}/admin/dashboard/`;
    setTimeout(() => location.assign(url), 50);
    return { selected: page, navigating: true, url };
  }

  // ---- Posts as the selected Page -----------------------------------------

  // plugin.linkedin post <open|draft|status> ...
  async post(action, ...args) {
    if (action === "open") return this.postOpen();
    if (action === "draft") return this.postDraft(args.join(" "));
    if (action === "status") return this.postStatus();
    throw new Error(`post needs a subcommand: open, draft, status (got ${action || "none"})`);
  }

  selectedPage() {
    const page = this.pageStore();
    if (!page) throw new Error('No page selected; run "page select <name>" first');
    return page;
  }

  editor() {
    return document.querySelector('[role="textbox"][aria-label*="Text editor"], [role="textbox"][aria-label*="editor"]');
  }

  // The composer's identity button reads "<Page name> Post to Anyone".
  composerActor() {
    const b = [...document.querySelectorAll("button")].find((x) => /Post to /.test(x.textContent));
    return b ? this.clean(b.textContent).replace(/\s*Post to .*$/, "") : null;
  }

  postOpen() {
    const page = this.selectedPage();
    const url = `https://www.linkedin.com/company/${page.id}/admin/page-posts/published/?share=true`;
    setTimeout(() => location.assign(url), 50);
    return { page, navigating: true, url };
  }

  editorText(ed) {
    return [...ed.querySelectorAll("p")].map((p) => p.textContent).join("\n").trim();
  }

  postStatus() {
    const page = this.pageStore();
    const ed = this.editor();
    return { page, composerOpen: !!ed, postingAs: this.composerActor(), text: ed ? this.editorText(ed) : null };
  }

  async postDraft(text) {
    if (!text) throw new Error("post draft needs the post text");
    const page = this.selectedPage();
    const ed = await bsc.waitFor(() => this.editor(), 20, 250);
    if (!ed) throw new Error('Composer is not open; run "post open" first');
    const actor = this.composerActor();
    if (actor !== page.name) throw new Error(`Composer posts as "${actor}", not the selected page "${page.name}"; run "post open"`);
    ed.focus();
    // selectAll is ignored by the editor; an explicit Range works.
    const range = document.createRange();
    range.selectNodeContents(ed);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.execCommand("delete");
    text.split("\n").forEach((line, i) => {
      if (i) document.execCommand("insertParagraph");
      if (line) document.execCommand("insertText", false, line);
    });
    await bsc.sleep(300);
    return { page, postingAs: actor, text: this.editorText(ed), published: false };
  }

  isPeopleSearch() {
    return location.hostname.endsWith("linkedin.com") && location.pathname.startsWith("/search/results/people");
  }

  // A result card: a listitem whose first <p> with a profile link is the name line.
  nameLine(card) {
    return [...card.querySelectorAll("p")].find((p) => p.querySelector('a[href*="/in/"]') || /•\s*(1st|2nd|3rd)/.test(p.textContent));
  }

  cards() {
    return [...document.querySelectorAll('[role="listitem"]')].filter((el) => {
      const p = this.nameLine(el);
      return p && /•\s*(1st|2nd|3rd)/.test(p.textContent);
    });
  }

  parseCard(card) {
    const nameP = this.nameLine(card);
    const link = nameP.querySelector('a[href*="/in/"]');
    const degree = (nameP.textContent.match(/•\s*(1st|2nd|3rd\+?)/) || [])[1] || null;
    const rest = [...card.querySelectorAll("p")]
      .filter((p) => p !== nameP && !nameP.contains(p) && !p.querySelector("a"))
      .map((p) => this.clean(p.textContent))
      .filter(Boolean);
    const mutual = [...card.querySelectorAll("p")].map((p) => this.clean(p.textContent)).find((t) => /mutual connection/.test(t));
    const [headline = null, location = null, ...extra] = rest;
    let url = null;
    if (link) {
      const u = new URL(link.href);
      url = `${u.origin}${u.pathname}`;
    }
    return {
      name: this.clean(link ? link.textContent : nameP.textContent.replace(/•.*$/, "")) || "LinkedIn Member",
      degree,
      headline,
      location,
      url,
      mutual: mutual || null,
      extra,
    };
  }

  status() {
    const cards = this.isPeopleSearch() ? this.cards() : [];
    return {
      url: location.href,
      title: document.title,
      peopleSearch: this.isPeopleSearch(),
      signedIn: !/\/(login|authwall|checkpoint)/.test(location.pathname),
      page: Number(new URL(location.href).searchParams.get("page") || 1),
      results: cards.length,
    };
  }

  async searchResults(...args) {
    const { flags } = this.parseArgs(args);
    if (/\/(login|authwall|checkpoint)/.test(location.pathname)) {
      throw new Error(`LinkedIn is asking for sign-in/verification (${location.pathname}); resolve it in the browser first`);
    }
    if (!this.isPeopleSearch()) throw new Error(`Not on a people search page (${location.href}); run "search go" first`);
    // Cards render after the shell; settle once the count stops changing.
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 60 && stable < 2; i += 1) {
      await this.sleep(250);
      const n = this.cards().length;
      const empty = /No results found/i.test(document.body.innerText);
      if (n === 0 && empty) break;
      stable = n > 0 && n === last ? stable + 1 : 0;
      last = n;
    }
    let people = this.cards().map((c) => this.parseCard(c));
    if (flags.limit) people = people.slice(0, Number(flags.limit));
    return { page: this.status().page, count: people.length, people };
  }
}
