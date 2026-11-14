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
        connections:
          "connections <go|list> — your own 1st-degree connections. go navigates this tab to the connections page (page unloads); list [--limit N] [--seconds S] scrolls the lazy list (foreground tab; ~20s per call, repeat until complete is true) and returns {total, count, complete, connections:[{name, headline, connected, url}]}.",
        invite:
          "invite <open|search|select|status|send> — invite your 1st-degree connections to follow the selected Page (costs one credit each). open navigates to the Page's invite dialog and resets the selection (page unloads); search <name> reads the matching connections ({name, degree, headline, selected}); select <name> ticks exactly one connection by exact name and verifies it against the Invite button's counter (error if zero or several match); status shows the counter and credits; send --yes clicks Invite for everyone ticked (without --yes it only reports what it would send). Each call has ~30s, so select one name per call.",
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
    const known = new Set(["title", "company", "school", "first", "last", "network", "page", "limit", "seconds"]);
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
    const want = text.trim();
    // The editor has been seen to keep only the first paragraph, so verify and retry once.
    for (let attempt = 0; attempt < 2; attempt++) {
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
      if (this.editorText(ed) === want) return { page, postingAs: actor, text: this.editorText(ed), published: false };
    }
    throw new Error(`Draft did not match the requested text; editor holds: ${JSON.stringify(this.editorText(ed))}`);
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

  // ---- Invite connections to follow the selected Page ----------------------

  // plugin.linkedin invite <open|search|select|status|send> ...
  async invite(action, ...args) {
    if (action === "open") return this.inviteOpen();
    if (action === "search") return this.inviteSearch(args.join(" "));
    if (action === "select") return this.inviteSelect(args.join(" "));
    if (action === "status") return this.inviteStatus();
    if (action === "send") return this.inviteSend(args);
    throw new Error(`invite needs a subcommand: open, search, select, status, send (got ${action || "none"})`);
  }

  // Navigating reloads the page, which also clears any ticked connections.
  inviteOpen() {
    const page = this.selectedPage();
    const url = `https://www.linkedin.com/company/${page.id}/admin/dashboard/?invite=true`;
    setTimeout(() => location.assign(url), 50);
    return { page, navigating: true, url };
  }

  fold(text) {
    return this.clean(text).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }

  inviteBox() {
    return document.querySelector('[role="combobox"][aria-label*="Search by name"], input[aria-label*="Search by name"]');
  }

  inviteButton() {
    return [...document.querySelectorAll("button")].find((b) => /^Invite( \d+)?$/.test(this.clean(b.textContent)));
  }

  inviteCount() {
    const b = this.inviteButton();
    const m = b && this.clean(b.textContent).match(/^Invite (\d+)$/);
    return m ? Number(m[1]) : 0;
  }

  // One entry per connection in the dialog: the row's label reads "Select <name>" or "Selected <name>".
  inviteRows() {
    return [...document.querySelectorAll('[role="option"]')]
      .map((el) => {
        const label = el.querySelector("label");
        const m = label && this.clean(label.textContent).match(/^(Select|Selected) (.+)$/);
        const text = this.clean(el.textContent);
        const deg = text.match(/\b(1st|2nd|3rd\+?)\b/);
        if (!m || !deg) return null;
        const rest = text.slice(text.indexOf(deg[1]) + deg[1].length).replace(/^\s*•\s*/, "");
        const tag = this.clean(label.textContent);
        const headline = rest.endsWith(tag) ? rest.slice(0, -tag.length).trim() : rest;
        return { el, label, name: m[2], degree: deg[1], headline, selected: m[1] === "Selected" };
      })
      .filter(Boolean);
  }

  async inviteSearch(name) {
    if (!name) throw new Error("invite search needs a name");
    const box = await bsc.waitFor(() => this.inviteBox(), 20, 250);
    if (!box) throw new Error('Invite dialog is not open; run "page select" then "invite open"');
    // Type only the Latin part of a name (typing CJK characters hangs the box); matching on the full name still happens in select.
    const query = name.replace(/[^\x00-\x7F]/g, "").trim() || name;
    bsc.fill(box, query, { clear: true, typing: true });
    const want = this.fold(query);
    // The list is replaced asynchronously; wait until a row for this name shows up (or give up and return what is there).
    await bsc.waitFor(() => this.inviteRows().some((r) => this.fold(r.name).includes(want)), 16, 250);
    await this.sleep(300);
    return this.inviteRows().map(({ el, label, ...rest }) => rest);
  }

  async inviteSelect(name) {
    const rows = await this.inviteSearch(name);
    const want = this.fold(name);
    const hits = rows.filter((r) => this.fold(r.name) === want);
    if (hits.length !== 1) {
      throw new Error(`${hits.length ? "Ambiguous" : "No exact match"} for "${name}"; candidates: ${rows.map((r) => `${r.name} (${r.headline.slice(0, 40)})`).join("; ") || "(none)"}`);
    }
    if (hits[0].selected) return { name: hits[0].name, selected: true, already: true, count: this.inviteCount() };
    const before = this.inviteCount();
    const row = this.inviteRows().find((r) => this.fold(r.name) === want);
    // One native click: bsc.click also fires synthetic events first, which toggles the checkbox twice.
    row.label.click();
    const ok = await bsc.waitFor(() => this.inviteCount() > before, 12, 250);
    if (!ok) throw new Error(`Clicking "${hits[0].name}" did not raise the Invite counter (still ${this.inviteCount()})`);
    return { name: hits[0].name, selected: true, count: this.inviteCount() };
  }

  inviteStatus() {
    const credits = document.body.innerText.match(/(\d+)\/(\d+) credits available/);
    return {
      dialogOpen: !!this.inviteBox(),
      selected: this.inviteCount(),
      creditsAvailable: credits ? Number(credits[1]) : null,
      creditsTotal: credits ? Number(credits[2]) : null,
    };
  }

  // Sends the invitations. Each one costs a credit and cannot be recalled, so it needs an explicit --yes.
  async inviteSend(args) {
    const count = this.inviteCount();
    if (!count) throw new Error("Nobody is selected");
    if (!args.includes("--yes")) return { sent: false, wouldInvite: count, hint: "run again with --yes to send" };
    const btn = this.inviteButton();
    bsc.click(btn);
    await this.sleep(1500);
    return { clicked: true, invited: count, status: this.inviteStatus() };
  }

  // ---- Your own connections -----------------------------------------------

  // plugin.linkedin connections <go|list> ...
  async connections(action, ...args) {
    if (action === "go") return this.connectionsGo();
    if (action === "list") return this.connectionsList(...args);
    throw new Error(`connections needs a subcommand: go, list (got ${action || "none"})`);
  }

  connectionsGo() {
    const url = "https://www.linkedin.com/mynetwork/invite-connect/connections/";
    setTimeout(() => location.assign(url), 50);
    return { navigating: true, url };
  }

  // One entry per "Connected on <date>" line: climb to the nearest ancestor that holds the /in/ link.
  connectionRows() {
    const rows = [];
    const seen = new Set();
    for (const el of document.querySelectorAll("p, span")) {
      const m = this.clean(el.textContent).match(/^Connected on (.+)$/);
      if (!m || el.querySelector("p, span")) continue;
      let card = el.parentElement;
      while (card && !card.querySelector('a[href*="/in/"]')) card = card.parentElement;
      if (!card) continue;
      const link = card.querySelector('a[href*="/in/"]');
      const u = new URL(link.href);
      const url = `${u.origin}${u.pathname}`;
      if (seen.has(url)) continue;
      seen.add(url);
      const lines = [...card.querySelectorAll("p")]
        .map((p) => this.clean(p.textContent))
        .filter((t) => t && !/^Connected on /.test(t) && t !== "Message");
      rows.push({ name: lines[0] || null, headline: lines[1] || null, connected: m[1], url, el });
    }
    return rows;
  }

  connectionsTotal() {
    const m = document.body.innerText.match(/([\d,]+)\s+connections\b/);
    return m ? Number(m[1].replace(/,/g, "")) : null;
  }

  // plugin.linkedin connections list [--limit N] [--seconds S] — scrolls the lazy list until every connection is
  // loaded or the time budget (default 20s, the extension gives up on a call after ~30s) runs out. Loaded cards stay
  // in the page, so run it again until "complete" is true. Needs a foreground tab: LinkedIn loads more on scroll.
  async connectionsList(...args) {
    if (!location.pathname.startsWith("/mynetwork/invite-connect/connections")) {
      throw new Error('Not on the connections page; run "connections go" first');
    }
    const { flags } = this.parseArgs(args);
    const limit = flags.limit ? Number(flags.limit) : Infinity;
    const total = this.connectionsTotal();
    let rows = (await bsc.waitFor(() => (this.connectionRows().length ? this.connectionRows() : null), 40, 250)) || [];
    const deadline = Date.now() + 1000 * Number(flags.seconds || 20);
    let stalls = 0;
    while (rows.length < Math.min(limit, total || Infinity) && stalls < 4 && Date.now() < deadline) {
      const last = rows[rows.length - 1];
      if (last) last.el.scrollIntoView({ block: "end" });
      window.scrollTo(0, document.documentElement.scrollHeight);
      const more = [...document.querySelectorAll("button")].find((b) => /^Show more results$/i.test(this.clean(b.textContent)));
      if (more) bsc.fireClick(more);
      await this.sleep(1200);
      const next = this.connectionRows();
      stalls = next.length > rows.length ? 0 : stalls + 1;
      rows = next;
    }
    const connections = rows.slice(0, limit).map(({ el, ...rest }) => rest);
    const lines = [...document.querySelectorAll("p, span")].filter((e) => !e.querySelector("p, span") && /^Connected on /.test(this.clean(e.textContent))).length;
    return { total, count: connections.length, connectedOnLines: lines, complete: total ? connections.length >= total : null, connections };
  }
}
