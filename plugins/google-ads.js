// Built-in plugin: Google Ads Keyword Planner "Discover new keywords".
//
//   browser-session-ctl --profile <name> plugin.google-ads search "running shoes, hoka"
//   browser-session-ctl --profile <name> plugin.google-ads search "shoes" --site=https://example.com
//   browser-session-ctl --profile <name> plugin.google-ads results 20
//   browser-session-ctl --profile <name> plugin.google-ads all 300
//   browser-session-ctl --profile <name> plugin.google-ads next
//   browser-session-ctl --profile <name> plugin.google-ads sort "Avg. monthly searches"
//
// ads.google.com is AngularDart (ng-app, _ngcontent-* classes, ess-*/material-*
// components, `angularDart*` globals), not React, so this drives plain DOM
// events (bsc.fireClick / bsc.fill / bsc.press). It uses fireClick, not click:
// bsc.click also calls el.click(), which lands a second click and makes a
// pager skip a page. What makes it reliable is
// bsc.angular.whenStable(): Angular's own testability registry reports when
// change detection and pending requests have settled, so every step waits on
// the framework instead of a guessed sleep.
//
// Read-only: it runs searches and reads the results. It never creates a plan,
// saves keywords, or touches a campaign.
class Plugin {
  help() {
    return {
      namespace: "google-ads",
      methods: {
        help: "Show this message.",
        status: "status — which Keyword Planner screen this is, the seeds/location/language of the current search, and the result counts.",
        search:
          'search <keywords> [--site=<url>] — run "Discover new keywords". Keywords are comma-separated. Waits for results and returns the summary plus the first rows.',
        results: "results [limit] — the rows on the current results page as records (default 100).",
        all: "all [max] — walk every results page and collect up to <max> rows (default 500).",
        next: "next | prev | first | last — change results page; returns the new page range.",
        sort: "sort <column...> — click a sortable column header (label or essfield), e.g. sort Avg. monthly searches.",
        open: "open — go back to the Keyword Planner start screen without reloading the page.",
        stable: "stable — wait for Angular to settle and report whether it did (debug).",
      },
    };
  }

  // ---- waiting -------------------------------------------------------------

  // Wait on the framework. If the probe is unavailable (extension too old, or a
  // page without a testability registry) fall back to a short sleep.
  async settle(timeoutMs = 15000) {
    try {
      const r = await bsc.angular.whenStable(timeoutMs);
      if (r?.stable === null) await bsc.sleep(500);
      return r;
    } catch {
      await bsc.sleep(500);
      return { stable: null };
    }
  }

  async stable() {
    return this.settle();
  }

  // ---- screens ---------------------------------------------------------------

  screen() {
    const path = location.pathname;
    if (/keywordplanner\/ideas/.test(path)) return "ideas";
    if (/keywordplanner\/home/.test(path)) return "home";
    if (/keywordplanner/.test(path)) return "other-keyword-planner";
    return "not-keyword-planner";
  }

  requireKeywordPlanner() {
    if (!/\/aw\/keywordplanner/.test(location.pathname)) {
      throw new Error(
        `This tab is not Keyword Planner (${location.pathname}). Open Tools > Planning > Keyword Planner in Google Ads first.`
      );
    }
  }

  buttonByText(text, scope = document) {
    const want = text.toLowerCase();
    return [...scope.querySelectorAll("material-button, button, [role=button]")].find(
      (b) => bsc.clean(b.getAttribute("aria-label") || b.textContent).toLowerCase() === want && bsc.isDisplayed(b)
    );
  }

  // The feature tour dialogs ("Assign keywords to ad groups automatically",
  // "When to use each card") sit on top of the page and swallow clicks.
  async dismissTips() {
    for (let i = 0; i < 4; i += 1) {
      const dialog = [...document.querySelectorAll("material-dialog, [role=dialog]")].find(
        (d) => bsc.isDisplayed(d) && /Assign keywords to ad groups|When to use each card/i.test(d.innerText)
      );
      if (!dialog) return i > 0;
      const btn = this.buttonByText("Explore Keyword Planner", dialog) || this.buttonByText("Next", dialog);
      if (!btn) throw new Error("A tip dialog is covering Keyword Planner and has no button this plugin knows.");
      bsc.fireClick(btn);
      await this.settle();
    }
    return true;
  }

  async open() {
    this.requireKeywordPlanner();
    await this.dismissTips();
    if (this.screen() === "home") return { screen: "home" };
    // SPA navigation through the side menu keeps this page (and plugin) alive;
    // a full navigation would reload the tab mid-call.
    const entry = [...document.querySelectorAll('a[href*="/aw/keywordplanner/home"]')].find((a) => bsc.isDisplayed(a));
    if (!entry) throw new Error("No link back to the Keyword Planner start screen on this page.");
    bsc.fireClick(entry);
    const ok = await bsc.waitFor(() => this.screen() === "home", 30, 250);
    if (!ok) throw new Error("Did not reach the Keyword Planner start screen.");
    await this.settle();
    await this.dismissTips();
    return { screen: "home" };
  }

  seedInput() {
    return document.querySelector('input[aria-label="Search input"]');
  }

  async openDiscoverCard() {
    if (this.seedInput() && bsc.isDisplayed(this.seedInput())) return;
    const card = [...document.querySelectorAll("material-button, button, [role=button]")].find(
      (b) => /^Discover new keywords\b/i.test(bsc.clean(b.getAttribute("aria-label") || b.textContent)) && bsc.isDisplayed(b)
    );
    if (!card) throw new Error('Could not find the "Discover new keywords" card.');
    bsc.fireClick(card);
    const input = await bsc.waitFor(() => this.seedInput() && bsc.isDisplayed(this.seedInput()), 30, 250);
    if (!input) throw new Error("The Discover new keywords form did not open.");
    await this.settle();
  }

  // ---- searching -------------------------------------------------------------

  parseArgs(parts) {
    const flags = {};
    const words = [];
    for (const p of parts) {
      const m = /^--([a-z-]+)=(.*)$/i.exec(p);
      if (m) flags[m[1]] = m[2];
      else words.push(p);
    }
    return { flags, text: words.join(" ") };
  }

  chips() {
    return [...document.querySelectorAll("search-chips-selector material-chip, material-chips material-chip")]
      .filter((c) => bsc.isDisplayed(c))
      .map((c) => bsc.clean(c.innerText));
  }

  async addSeed(text) {
    const input = this.seedInput();
    bsc.fill(input, text, { typing: true });
    await this.settle();
    bsc.press(input, "Enter");
    await this.settle();
    if (!this.chips().some((c) => c.toLowerCase() === text.toLowerCase())) {
      throw new Error(`Keyword "${text}" did not turn into a chip (chips: ${this.chips().join(", ") || "none"}).`);
    }
  }

  async search(...parts) {
    const { flags, text } = this.parseArgs(parts);
    const seeds = text.split(",").map((s) => bsc.clean(s)).filter(Boolean);
    if (!seeds.length) throw new Error('usage: search "<keyword>[, <keyword>...]" [--site=<url>]');

    this.requireKeywordPlanner();
    await this.open();
    await this.openDiscoverCard();

    // Start from an empty seed list: remove any chips left from an earlier try.
    for (let i = 0; i < 25 && this.chips().length; i += 1) {
      const x = document.querySelector("search-chips-selector material-chip [aria-label*='emove'], search-chips-selector material-chip material-icon");
      if (!x) break;
      bsc.fireClick(x);
      await this.settle();
    }

    for (const seed of seeds) await this.addSeed(seed);

    if (flags.site) {
      const site = document.querySelector('input[aria-label="Enter a site to filter unrelated keywords"]');
      if (!site) throw new Error("The site filter field is not on this form.");
      bsc.fill(site, flags.site, { typing: true });
      await this.settle();
    }

    const go = this.buttonByText("Get results");
    if (!go) throw new Error('"Get results" button not found.');
    bsc.fireClick(go);
    const landed = await bsc.waitFor(() => this.screen() === "ideas" && this.rowEls().length > 0, 60, 250);
    if (!landed) throw new Error("Keyword ideas did not load. Is the account allowed to use Keyword Planner?");
    await this.settle();
    const out = this.status();
    out.rows = (await this.results(10)).rows;
    return out;
  }

  // ---- reading results -------------------------------------------------------

  rowEls() {
    return [...document.querySelectorAll('ess-particle-table [role="row"].particle-table-row')];
  }

  headers() {
    return [...document.querySelectorAll('ess-particle-table [role="columnheader"]')].map((el) => ({
      field: el.getAttribute("essfield") || null,
      label: bsc.clean((el.getAttribute("aria-label") || el.textContent).replace(/help_outline/g, "")) || null,
      sort: (el.getAttribute("aria-sort") || "none").replace("ending", ""),
      sortable: /sortable/i.test(el.getAttribute("aria-description") || ""),
    }));
  }

  // "100K – 1M" -> {min: 100000, max: 1000000}. The planner only gives ranges.
  parseRange(raw) {
    const num = (s) => {
      const m = /^([\d.,]+)\s*([KM]?)$/i.exec(String(s).trim());
      if (!m) return null;
      return Math.round(parseFloat(m[1].replace(/,/g, "")) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1));
    };
    const [lo, hi] = String(raw).split(/\s*[–-]\s*/);
    return { min: num(lo), max: num(hi ?? lo) };
  }

  parseMoney(raw) {
    const m = /\$?([\d,.]+)/.exec(String(raw));
    return m ? parseFloat(m[1].replace(/,/g, "")) : null;
  }

  record(row, section) {
    const cell = (field) => {
      const el = row.querySelector(`ess-cell[essfield="${field}"]`);
      return el ? bsc.clean(el.innerText) : null;
    };
    const volume = cell("search_volume");
    const range = volume ? this.parseRange(volume) : { min: null, max: null };
    return {
      keyword: cell("text"),
      section,
      avgMonthlySearches: volume,
      searchesMin: range.min,
      searchesMax: range.max,
      threeMonthChange: cell("recent_search_trend_change"),
      yoyChange: cell("recent_yoy_search_trend_change"),
      competition: cell("competition"),
      adImpressionShare: cell("ad_impression_share"),
      bidLow: this.parseMoney(cell("bid_min")),
      bidHigh: this.parseMoney(cell("bid_max")),
    };
  }

  // The grid interleaves group labels ("Keywords you provided", "Keyword
  // ideas") with the rows; track the last label seen so each row carries it.
  readRows(startSection = null) {
    const rows = this.rowEls();
    if (!rows.length) return [];
    const grid = rows[0].parentElement;
    let section = startSection;
    const out = [];
    for (const child of grid.children) {
      if (child.matches('[role="row"].particle-table-row')) {
        out.push(this.record(child, section));
        continue;
      }
      if (child.classList.contains("group-header")) section = bsc.clean(child.innerText) || null;
    }
    return out;
  }

  pageInfo() {
    const text = bsc.clean(document.body.innerText);
    const range = /(\d[\d,]*) - (\d[\d,]*) of (\d[\d,]*)/.exec(text);
    return range
      ? { from: Number(range[1].replace(/,/g, "")), to: Number(range[2].replace(/,/g, "")), total: Number(range[3].replace(/,/g, "")) }
      : null;
  }

  status() {
    const screen = this.screen();
    const out = { screen, url: location.pathname };
    if (screen === "home") out.chips = this.chips();
    if (screen !== "ideas") return out;
    const text = bsc.clean(document.body.innerText);
    const showing = /Showing ([\d,]+)(?: of ([\d,]+))? keyword ideas/i.exec(text);
    const seed = /Organize keywords\s+search\s+(.+?)\s+location_on\s+(.+?)\s+translate\s+(.+?)\s+manage_search\s+(.+?)\s+calendar_today\s+(.+?)\s+arrow_drop_down/i.exec(text);
    // With a site filter the seed box reads "<keywords> info_outline <url>".
    const [seeds, site] = seed ? seed[1].split(/\s+info_outline\s+/) : [];
    out.search = seed
      ? { seeds, ...(site ? { site } : {}), location: seed[2], language: seed[3], network: seed[4], dateRange: seed[5] }
      : null;
    const available = /([\d,]+) keyword ideas available/i.exec(text);
    const n = (x) => Number(x.replace(/,/g, ""));
    out.ideas = available ? { shown: n(available[1]), total: n(available[1]) } : showing ? { shown: Number(showing[1].replace(/,/g, "")), total: Number((showing[2] || showing[1]).replace(/,/g, "")) } : null;
    out.page = this.pageInfo();
    out.columns = this.headers().map((h) => h.label);
    return out;
  }

  // The table is virtualized: only the ~10 rows near the viewport exist in the
  // DOM, out of the 100 on a page. The scrolling element is the page shell
  // (.awsm-nav-bar-and-content), not the table, so find it by overflow.
  scroller() {
    const row = this.rowEls()[0];
    for (let e = row; e && e !== document.body; e = e.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4) return e;
    }
    return document.scrollingElement;
  }

  // Scroll the current page top to bottom, collecting each row as it renders.
  async pageRows(limit = Infinity, startSection = null) {
    const info = this.pageInfo();
    const want = Math.min(limit, info ? info.to - info.from + 1 : Infinity);
    const sc = this.scroller();
    sc.scrollTop = 0;
    await this.settle(2000);
    const seen = new Map();
    let section = startSection;
    for (let step = 0; step < 80 && seen.size < want; step += 1) {
      for (const rec of this.readRows(section)) {
        if (rec.section) section = rec.section;
        else rec.section = section;
        if (rec.keyword && !seen.has(rec.keyword)) seen.set(rec.keyword, rec);
      }
      const before = sc.scrollTop;
      sc.scrollTop = before + Math.max(120, Math.floor(sc.clientHeight * 0.6));
      await bsc.sleep(80);
      await this.settle(2000);
      if (sc.scrollTop === before) break;
    }
    sc.scrollTop = 0;
    return { rows: [...seen.values()].slice(0, want), section };
  }

  async results(limit = 100) {
    if (this.screen() !== "ideas") throw new Error("No keyword results here. Run search first.");
    await this.settle();
    const n = Math.max(1, Number(limit) || 100);
    const { rows } = await this.pageRows(n);
    return { page: this.pageInfo(), count: rows.length, rows };
  }

  // ---- paging & sorting ------------------------------------------------------

  async turn(label) {
    const btn = [...document.querySelectorAll("material-button")].find(
      (b) => b.getAttribute("aria-label") === label && bsc.isDisplayed(b)
    );
    if (!btn) throw new Error(`No "${label}" control on this page.`);
    if (btn.hasAttribute("disabled") || btn.getAttribute("aria-disabled") === "true") return null;
    const before = this.pageInfo()?.from;
    bsc.fireClick(btn);
    await bsc.waitFor(() => this.pageInfo()?.from !== before, 40, 250);
    await this.settle();
    return this.pageInfo();
  }

  async next() {
    return (await this.turn("Go to the next page")) || { note: "already on the last page", page: this.pageInfo() };
  }
  async prev() {
    return (await this.turn("Go to the previous page")) || { note: "already on the first page", page: this.pageInfo() };
  }
  async first() {
    return (await this.turn("Go to the first page")) || { note: "already on the first page", page: this.pageInfo() };
  }
  async last() {
    return (await this.turn("Go to the last page")) || { note: "already on the last page", page: this.pageInfo() };
  }

  async all(max = 500) {
    if (this.screen() !== "ideas") throw new Error("No keyword results here. Run search first.");
    const cap = Math.max(1, Number(max) || 500);
    await this.first();
    const rows = [];
    let section = null;
    for (let guard = 0; guard < 200 && rows.length < cap; guard += 1) {
      const got = await this.pageRows(cap - rows.length, section);
      rows.push(...got.rows);
      section = got.section;
      if (rows.length >= cap) break;
      if (!(await this.turn("Go to the next page"))) break;
    }
    return { total: this.pageInfo()?.total ?? null, count: rows.length, rows };
  }

  async sort(...parts) {
    const want = bsc.clean(parts.join(" ")).toLowerCase();
    if (!want) throw new Error("usage: sort <column>");
    const els = [...document.querySelectorAll('ess-particle-table [role="columnheader"]')];
    const label = (e) => bsc.clean((e.getAttribute("aria-label") || e.textContent).replace(/help_outline/g, "")).toLowerCase();
    const el = els.find((e) => (e.getAttribute("essfield") || "").toLowerCase() === want || label(e) === want) ||
      els.find((e) => label(e).includes(want));
    if (!el) throw new Error(`No column "${want}". Columns: ${this.headers().map((h) => h.label).join(", ")}`);
    if (!/sortable/i.test(el.getAttribute("aria-description") || "")) throw new Error(`Column "${want}" is not sortable.`);
    const before = el.getAttribute("aria-sort");
    bsc.fireClick(el);
    await bsc.waitFor(() => el.getAttribute("aria-sort") !== before, 24, 250);
    await this.settle();
    return this.headers().find((h) => h.field === el.getAttribute("essfield"));
  }
}
