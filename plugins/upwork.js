// Built-in plugin: search Upwork freelancers (www.upwork.com/nx/search/talent/).
//
//   browser-session-ctl --tab <id> plugin.upwork search go "public relations" --rate 15-40 --location "United States"
//   browser-session-ctl --tab <id> plugin.upwork search results --limit 10
//
// Upwork's talent search is addressed entirely by URL (?q=...&hourly_rate=a-b
// &location=...&page=N), and each freelancer is an <article class="freelancer-tile">.
// The tile fields are read from stable class names (.name, .title, .location,
// .details, .air3-token, .description). Upwork only exposes a COUNTRY for each
// freelancer, never a city, so "New York" cannot be filtered or verified here.
//
// This plugin is read-only: it never saves, invites or messages anyone.
// `search go` / `search next` / `profile open` navigate, which unloads the page
// and this plugin instance, so they only schedule the navigation; run the next
// command as a separate call once the page has loaded.
class Plugin {
  help() {
    return {
      namespace: "upwork",
      methods: {
        help: "Show this message.",
        search:
          "search <url|go|results|next> — freelancer search. url/go take: <keywords...> [--rate MIN-MAX] [--location COUNTRY] [--badge top_rated|top_rated_plus|rising_talent] [--page N]. url builds the URL only; go navigates this tab (page unloads); results [--limit N] waits for and returns the tiles ({name, url, title, location, rate, jobSuccess, earned, available, badge, boosted, relevantJobs, skills, description}); next goes to the next results page.",
        profile:
          "profile open <url-or-path> — navigate this tab to a freelancer profile (read-only); then use `text` to read it.",
        status: "status — url, whether this is a talent search, signed in, tile count, total pages.",
      },
    };
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  clean(text) {
    return String(text || "").replace(/[‎‏]/g, "").replace(/\s+/g, " ").trim();
  }

  parseArgs(args) {
    const flags = {};
    const words = [];
    const known = new Set(["rate", "location", "badge", "page", "limit"]);
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
    if (keywords) params.set("q", keywords);
    if (flags.rate) params.set("hourly_rate", flags.rate.replace(/\s/g, ""));
    if (flags.location) params.set("location", flags.location);
    if (flags.badge) params.set("top_rated_status", flags.badge);
    if (flags.page && Number(flags.page) > 1) params.set("page", String(Number(flags.page)));
    params.set("nbs", "1");
    return "https://www.upwork.com/nx/search/talent/?" + params.toString();
  }

  navigate(url) {
    setTimeout(() => location.assign(url), 50);
    return { navigating: true, url };
  }

  tiles() {
    return [...document.querySelectorAll("article.freelancer-tile")];
  }

  isSignedOut() {
    return /\/ab\/account-security\/login|\/nx\/signup|just a moment/i.test(location.href + " " + document.title);
  }

  parseTile(t) {
    const q = (sel) => this.clean((t.querySelector(sel) || {}).innerText);
    const link = t.querySelector("a.profile-link, h5.name a");
    let url = null;
    if (link) {
      try {
        const u = new URL(link.getAttribute("href"), location.origin);
        url = u.origin + u.pathname;
      } catch (e) {
        url = null;
      }
    }
    const details = this.clean((t.querySelector(".details") || {}).innerText);
    const rate = (details.match(/\$[\d,.]+(?:\s*-\s*\$[\d,.]+)?\s*\/\s*hr/i) || [null])[0];
    const jss = (details.match(/(\d+)%\s*Job Success/i) || [null, null])[1];
    const earned = (details.match(/\$[\d,.]+[KM]?\+?\s*earned/i) || [null])[0];
    const tier = t.querySelector(".freelancer-tier [aria-label]");
    const text = this.clean(t.innerText);
    const rel = text.match(/has worked (\d+) jobs? related to your search/i);
    return {
      name: q("h5.name"),
      url,
      title: q(".title"),
      location: q(".location"),
      rate: rate ? this.clean(rate) : null,
      jobSuccess: jss ? Number(jss) : null,
      earned: earned ? this.clean(earned) : null,
      available: /open for work/i.test(details),
      badge: tier ? tier.getAttribute("aria-label") : null,
      boosted: !!t.querySelector(".boosted"),
      relevantJobs: rel ? Number(rel[1]) : null,
      skills: [...t.querySelectorAll(".air3-token")].map((e) => this.clean(e.innerText)).filter((s) => s && !/^\+\d+$/.test(s)),
      description: q(".description").slice(0, 400),
    };
  }

  totalPages() {
    const m = this.clean((document.querySelector("[data-test*='ProfilesPagination']") || {}).innerText).match(/of (\d+)/);
    return m ? Number(m[1]) : null;
  }

  currentPage() {
    const m = new URL(location.href).searchParams.get("page");
    return m ? Number(m) : 1;
  }

  status() {
    return {
      url: location.href,
      isTalentSearch: /\/nx\/search\/talent\//.test(location.pathname),
      signedOut: this.isSignedOut(),
      tiles: this.tiles().length,
      page: this.currentPage(),
      totalPages: this.totalPages(),
    };
  }

  async search(sub, ...args) {
    if (sub === "url") return this.buildUrl(args);
    if (sub === "go") return this.navigate(this.buildUrl(args));
    if (sub === "next") {
      const u = new URL(location.href);
      u.searchParams.set("page", String(this.currentPage() + 1));
      return this.navigate(u.toString());
    }
    if (sub === "results") {
      const { flags } = this.parseArgs(args);
      const limit = flags.limit ? Number(flags.limit) : 10;
      const tiles = await bsc.waitFor(() => (this.tiles().length ? this.tiles() : null), 40, 250);
      if (!tiles) {
        if (this.isSignedOut()) throw new Error("Upwork shows a login or verification page; sign in or solve it in the tab, then retry.");
        return { count: 0, page: this.currentPage(), totalPages: this.totalPages(), people: [], note: "no tiles found (no results, or the page has not loaded)" };
      }
      await this.sleep(500);
      const people = this.tiles().slice(0, limit).map((t) => this.parseTile(t));
      return { count: people.length, page: this.currentPage(), totalPages: this.totalPages(), people };
    }
    throw new Error("search: expected url|go|results|next");
  }

  profile(sub, target) {
    if (sub !== "open" || !target) throw new Error("profile: expected `open <url-or-path>`");
    const u = new URL(String(target), "https://www.upwork.com");
    if (!/(^|\.)upwork\.com$/.test(u.hostname)) throw new Error("profile open: only upwork.com URLs");
    return this.navigate(u.toString());
  }
}
