// Built-in plugin: search JewishGen's Global (Unified) Search
// (www.jewishgen.org/search/Global_Search.php).
//
//   browser-session-ctl --tab <id> plugin.jewishgen search go --surname Zajac --town Lwow --region ukraine
//   browser-session-ctl --tab <id> plugin.jewishgen search results --limit 20
//
// The search page is a plain HTML form that POSTs to /search-results.php:
//   srch1v/srch1t/srch1 and srch2v/srch2t/srch2 are (data type, match type, term)
//   triples, and `allcountry` picks the region/collection. The data types are
//   S=Surname, G=Given Name, T=Town, X=Any Field; the match types are
//   Q=Phonetically Like, D=Sounds Like, S=Starts With, C=Contains, E=Is Exactly,
//   F1/F2/FM=Fuzzy/Fuzzier/Fuzziest. Only two term rows are usable without a
//   JewishGen account (rows 3 and 4 are locked), so at most two criteria are sent.
//
// This plugin is read-only: it only submits the search form and reads results.
// `search go` submits the form, which unloads the page and this plugin instance,
// so it only schedules the submit; run `search results` as a separate call once
// the results page has loaded.
class Plugin {
  help() {
    return {
      namespace: "jewishgen",
      methods: {
        help: "Show this message.",
        regions: "regions — the region/collection codes accepted by --region (code and label).",
        search:
          "search <go|results> — go: fill and submit the Global Search form on this tab (page unloads). Flags: [--surname S] [--given G] [--town T] [--any TEXT] [--match phonetic|sounds|starts|contains|exact|fuzzy|fuzzier|fuzziest] [--region CODE]. Up to two of surname/given/town/any. Default match is phonetic. --region takes a code from `regions` or its name (e.g. ukraine, poland, israel, holocaust, usa). results [--limit N]: read the results page (database hit counts and rows, as far as it shows them).",
        status: "status — url, whether this is the search page or a results page, signed in.",
      },
    };
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  clean(text) {
    return String(text || "").replace(/[‎‏]/g, "").replace(/\s+/g, " ").trim();
  }

  isSearchPage() {
    return /\/search\/Global_Search\.php/i.test(location.pathname);
  }

  isResultsPage() {
    return /\/search-results\.php/i.test(location.pathname);
  }

  isSignedIn() {
    return !document.querySelector("a[href*='Auth0/login.php']");
  }

  parseArgs(args) {
    const flags = {};
    const known = new Set(["surname", "given", "town", "any", "match", "region", "limit"]);
    for (let i = 0; i < args.length; i += 1) {
      const a = String(args[i]);
      if (a.startsWith("--") && known.has(a.slice(2))) {
        flags[a.slice(2)] = String(args[i + 1] === undefined ? "" : args[i + 1]);
        i += 1;
      } else {
        throw new Error("unknown argument: " + a);
      }
    }
    return flags;
  }

  matchCode(word) {
    const codes = {
      phonetic: "Q", sounds: "D", starts: "S", contains: "C", exact: "E",
      fuzzy: "F1", fuzzier: "F2", fuzziest: "FM",
    };
    const w = String(word || "phonetic").toLowerCase();
    if (codes[w]) return codes[w];
    if (Object.values(codes).includes(String(word).toUpperCase())) return String(word).toUpperCase();
    throw new Error("--match: expected " + Object.keys(codes).join("|"));
  }

  regionSelect() {
    return document.querySelector("select[name=allcountry]");
  }

  regions() {
    const sel = this.regionSelect();
    if (!sel) throw new Error("regions: open https://www.jewishgen.org/search/Global_Search.php first");
    return [...sel.options].map((o) => ({ code: o.value, label: this.clean(o.text) }));
  }

  pickRegion(name) {
    const sel = this.regionSelect();
    const want = String(name).toLowerCase();
    const opt =
      [...sel.options].find((o) => o.value.toLowerCase() === want) ||
      [...sel.options].find((o) => o.value.toLowerCase().replace(/^\d*/, "") === want) ||
      [...sel.options].find((o) => this.clean(o.text).toLowerCase() === want) ||
      [...sel.options].find((o) => this.clean(o.text).toLowerCase().includes(want));
    if (!opt) throw new Error("--region: no match for " + name + "; run `regions`");
    return opt.value;
  }

  criteria(flags) {
    const rows = [];
    if (flags.surname) rows.push(["S", flags.surname]);
    if (flags.given) rows.push(["G", flags.given]);
    if (flags.town) rows.push(["T", flags.town]);
    if (flags.any) rows.push(["X", flags.any]);
    if (!rows.length) throw new Error("search go: give at least one of --surname --given --town --any");
    if (rows.length > 2) throw new Error("search go: at most two of --surname --given --town --any (rows 3 and 4 need an account)");
    return rows;
  }

  go(flags) {
    if (!this.isSearchPage()) {
      setTimeout(() => location.assign("https://www.jewishgen.org/search/Global_Search.php"), 50);
      return { navigating: true, note: "this tab was not on the search page; now loading it. Run `search go` again." };
    }
    const rows = this.criteria(flags);
    const match = this.matchCode(flags.match);
    rows.forEach(([type, term], i) => {
      const n = i + 1;
      bsc.select(document.querySelector("select[name=srch" + n + "v]"), type);
      bsc.select(document.querySelector("select[name=srch" + n + "t]"), match);
      bsc.fill(document.querySelector("input[name=srch" + n + "]"), term, { clear: true });
    });
    if (flags.region) bsc.select(this.regionSelect(), this.pickRegion(flags.region));
    const button = document.getElementById("SearchButton");
    if (!button) throw new Error("search go: the SEARCH DATABASES button is missing");
    setTimeout(() => button.click(), 50);
    return { submitting: true, criteria: rows.map(([t, v]) => t + ":" + v), match, region: flags.region || "ALL" };
  }

  async results(flags) {
    const limit = flags.limit ? Number(flags.limit) : 25;
    if (!this.isResultsPage()) throw new Error("results: this tab is not on search-results.php");
    await bsc.waitFor(() => /Outside partners|Log in to see results|Dataset/i.test(document.body.innerText), 40, 250);
    await this.sleep(500);
    const heading = this.clean(((document.querySelector("h1") || {}).innerText) || "") || document.title;
    // Partner searches (JRI-Poland, Gesher Galicia, Shapell Roster) are plain links
    // via /leaving.php and work without an account. They are public sites.
    const partners = [...document.querySelectorAll("a[href*='leaving.php?partner=']")].map((a) => ({
      partner: new URL(a.href).searchParams.get("partner"),
      label: this.clean(a.innerText).replace(/\s*\(opens in a new tab\)\s*$/, ""),
      url: a.href,
    }));
    const needsLogin = /Log in to see results/i.test(document.body.innerText);
    const out = { title: document.title, signedIn: this.isSignedIn(), needsLogin, partners };
    if (needsLogin) {
      out.note =
        "JewishGen shows the record counts and rows only to signed-in users. Sign in to JewishGen in this tab yourself (the plugin never types credentials), then run `search go` again. Partner links above work without an account.";
      return out;
    }
    // Signed in: the dataset rows' markup has not been seen yet, so return the
    // text of the results region generically. Refine once real output is seen.
    const tables = [...document.querySelectorAll("table")].map((t) => {
      const rows = [...t.querySelectorAll("tr")].map((tr) => [...tr.children].map((c) => this.clean(c.innerText)));
      return { rows: rows.slice(0, limit), totalRows: rows.length };
    });
    out.tables = tables.filter((t) => t.totalRows > 0);
    return out;
  }

  async search(sub, ...args) {
    const flags = this.parseArgs(args);
    if (sub === "go") return this.go(flags);
    if (sub === "results") return await this.results(flags);
    throw new Error("search: expected go|results");
  }

  status() {
    return {
      url: location.href,
      isSearchPage: this.isSearchPage(),
      isResultsPage: this.isResultsPage(),
      signedIn: this.isSignedIn(),
    };
  }
}
