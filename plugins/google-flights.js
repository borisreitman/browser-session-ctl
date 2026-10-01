// Built-in plugin: search Google Flights and read the results list.
//
//   browser-session-ctl --tab <id> plugin.google-flights search YVR LCA 2026-10-16 2026-10-29
//   browser-session-ctl --tab <id> plugin.google-flights search YVR Cyprus 2026-10-16 2026-10-29
//   browser-session-ctl --tab <id> plugin.google-flights search YVR LCA 2026-10-16
//   browser-session-ctl --tab <id> plugin.google-flights search YVR LCA 2026-10-16 2026-10-29 business 2
//   browser-session-ctl --tab <id> plugin.google-flights sort cheapest
//   browser-session-ctl --tab <id> plugin.google-flights results
//   browser-session-ctl --tab <id> plugin.google-flights select 0
//   browser-session-ctl --tab <id> plugin.google-flights status
//
// Origin/destination widgets are custom typeaheads, so filling the homepage
// form from a plugin is brittle. `search` loads the same natural-language
// Flights URL Google itself uses (`/travel/flights?q=Flights from …`).
// Country names such as Cyprus are aliases for the main airport (LCA);
// otherwise Google sends you to the Explore map instead of a flight list.
class Plugin {
  help() {
    return {
      namespace: "google-flights",
      methods: {
        help: "Show this message.",
        search:
          "search <from> <to> <depart> [return] [cabin] [adults] — open Google Flights results. IATA codes (YVR, LCA) or a place name. Dates as YYYY-MM-DD or MM/DD/YYYY. Omit return (or pass oneway) for one-way. cabin: economy | premium | business | first. Country aliases: Cyprus → LCA. Then sort cheapest (default) and results.",
        sort: "sort [cheapest|best|fastest] — click a sort tab. Default: cheapest.",
        results:
          "results — wait for departing-flight cards (or Explore city cards) and return them in the page's current sort order. Does not change sort.",
        select:
          "select <index|text...> — click one offer (0-based index, or words matched against the label). On a roundtrip this opens returning flights. Does not book.",
        more: "more [max] — click 'View more flights' until the list stops growing (or max clicks, default 5).",
        stops: "stops [any|nonstop|1|2] — set the Stops filter. Default: nonstop.",
        close: "close — dismiss cookie consent and the Track prices dialog. No-op if neither is showing. Other methods that touch the page do this first.",
        status: "status — home, results, returning, explore, or other, plus sort and result count.",
      },
    };
  }

  // Places Google would send to /travel/explore instead of a flight list.
  placeAliases() {
    return {
      cyprus: { code: "LCA", name: "Larnaca" },
      larnaca: { code: "LCA", name: "Larnaca" },
      paphos: { code: "PFO", name: "Paphos" },
    };
  }

  place(value) {
    const raw = String(value || "").trim();
    if (!raw) throw new Error("empty place");
    const alias = this.placeAliases()[raw.toLowerCase()];
    if (alias) return { query: alias.code, label: raw, resolved: `${alias.name} (${alias.code})` };
    if (/^[A-Za-z]{3}$/.test(raw)) {
      const code = raw.toUpperCase();
      return { query: code, label: raw, resolved: code };
    }
    if (!/^[A-Za-z][A-Za-z .'-]*$/.test(raw)) {
      throw new Error(`"${value}" is not an airport code or place name (e.g. YVR, LCA, Cyprus).`);
    }
    return { query: raw, label: raw, resolved: raw };
  }

  cabinClass(value) {
    const raw = String(value || "economy").trim().toLowerCase().replace(/[_-]+/g, " ");
    if (raw === "economy" || raw === "coach") return "economy";
    if (raw === "premium" || raw === "premium economy" || raw === "economy premium") return "premium";
    if (raw === "business") return "business";
    if (raw === "first" || raw === "first class") return "first";
    throw new Error(`Unknown cabin "${value}". Use economy, premium, business, or first.`);
  }

  parseSearchArgs(from, to, depart, ...rest) {
    if (!from || !to || !depart) {
      throw new Error("usage: search <from> <to> <depart> [return] [cabin] [adults]");
    }
    const origin = this.place(from);
    const dest = this.place(to);
    const params = {
      from: origin.query,
      to: dest.query,
      fromLabel: origin.label,
      toLabel: dest.label,
      resolved: { from: origin.resolved, to: dest.resolved },
      depart: bsc.dates.toIso(depart),
      returnDate: null,
      trip: "oneway",
      cabin: "economy",
      adults: 1,
    };
    for (const token of rest) {
      if (token == null || token === "") continue;
      const lower = String(token).toLowerCase();
      if (bsc.dates.looksLikeDate(token)) {
        params.returnDate = bsc.dates.toIso(token);
        params.trip = "roundtrip";
        continue;
      }
      if (lower === "oneway" || lower === "one-way") {
        params.trip = "oneway";
        params.returnDate = null;
        continue;
      }
      if (lower === "roundtrip" || lower === "round-trip") {
        params.trip = "roundtrip";
        continue;
      }
      if (/^\d+$/.test(token)) {
        params.adults = Number(token);
        if (params.adults < 1 || params.adults > 9) throw new Error("adults must be between 1 and 9");
        continue;
      }
      params.cabin = this.cabinClass(token);
    }
    if (params.trip === "roundtrip" && !params.returnDate) {
      throw new Error("roundtrip search needs a return date");
    }
    return params;
  }

  searchUrl(p) {
    const bits = [`Flights from ${p.from} to ${p.to} on ${p.depart}`];
    if (p.returnDate) bits.push(`through ${p.returnDate}`);
    else bits.push("one way");
    if (p.cabin === "business") bits.push("business class");
    else if (p.cabin === "first") bits.push("first class");
    else if (p.cabin === "premium") bits.push("premium economy");
    if (p.adults > 1) bits.push(`${p.adults} passengers`);
    const q = encodeURIComponent(bits.join(" "));
    return `https://www.google.com/travel/flights?q=${q}&hl=en`;
  }

  search(from, to, depart, ...rest) {
    const params = this.parseSearchArgs(from, to, depart, ...rest);
    const url = this.searchUrl(params);
    // Navigate after this call returns — assigning location here would
    // unload the page before executeScript can send the result back.
    setTimeout(() => {
      location.assign(url);
    }, 50);
    return { ...params, url };
  }

  overlayButton() {
    const re =
      /^(reject all|reject additional cookies|stay signed out|no thanks|not now|continue without (agreeing|signing in))$/i;
    for (const el of document.querySelectorAll("button, [role='button'], a")) {
      if (re.test(bsc.clean(el.textContent))) return el;
    }
    return null;
  }

  trackPricesClose() {
    const heading = [...document.querySelectorAll("h1, h2, h3, [role='heading']")].find((el) =>
      /^track prices$/i.test(bsc.clean(el.textContent))
    );
    if (!heading) return null;
    const root = heading.closest("[role='dialog'], [role='alertdialog'], div") || document;
    return (
      [...root.querySelectorAll("button, [role='button']")].find((el) =>
        /^\s*close\s*$/i.test(bsc.clean(el.getAttribute("aria-label") || el.textContent))
      ) || null
    );
  }

  async dismissOverlays() {
    let dismissed = false;
    const cookie = this.overlayButton();
    if (cookie) {
      bsc.click(cookie);
      dismissed = true;
      await bsc.sleep(400);
    }
    const close = this.trackPricesClose();
    if (close) {
      bsc.click(close);
      dismissed = true;
      await bsc.sleep(300);
    }
    return { dismissed };
  }

  async close() {
    return this.dismissOverlays();
  }

  offerLinks() {
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll("a, [role='link']")) {
      const label = bsc.clean(el.getAttribute("aria-label") || "");
      if (!/^From \d/i.test(label) || !/dollars/i.test(label)) continue;
      const key = label.slice(0, 200);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(el);
    }
    return out;
  }

  exploreCards() {
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll("button, [role='button']")) {
      const name = bsc.clean(el.getAttribute("aria-label") || el.textContent || "");
      if (!/^[A-Za-z .'-]+ .+\d+ (hr|min).+\$[\d,]+/.test(name) && !/^[A-Za-z .'-]+ .+\$[\d,]+$/.test(name)) {
        continue;
      }
      if (/^(Paphos|Larnaca|Nicosia)\b/i.test(name) === false && !/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(name)) {
        continue;
      }
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(el);
    }
    return out;
  }

  hour24(t) {
    const m = String(t || "").match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
    if (!m) return null;
    let h = Number(m[1]) % 12;
    if (/pm/i.test(m[3])) h += 12;
    return h + Number(m[2]) / 60;
  }

  isUsWorkHours(t) {
    const h = this.hour24(t);
    if (h == null) return null;
    return h >= 9 && h < 17;
  }

  parseOffer(el, index) {
    const label = bsc.clean(el.getAttribute("aria-label") || "");
    const card = el.closest("li, [role='listitem']") || el.parentElement || el;
    const text = bsc.clean((card && card.innerText) || el.innerText || "");
    const dollars = label.match(/^From ([\d,]+) US dollars (round trip|one way) total/i);
    const stops = label.match(/\b(Nonstop|\d+\s*stops?)\b/i)?.[1] || text.match(/\b(Nonstop|\d+\s*stops?)\b/i)?.[1] || null;
    const airline = label.match(/flight with (.+?)\. Leaves /i)?.[1] || null;
    const trip = dollars?.[2] || label.match(/\b(round trip|one way)\b/i)?.[1] || null;
    const times = label.match(
      /Leaves (.+?) at (\d{1,2}:\d{2}\s*(?:AM|PM)) on (.+?) and arrives at (.+?) at (\d{1,2}:\d{2}\s*(?:AM|PM))(?: on ([^.]+))?/i
    );
    const duration = text.match(/(\d+\s*hr(?:\s*\d+\s*min)?|\d+\s*min)\b/i)?.[1] || null;
    const route = text.match(/\b([A-Z]{3})\s*[–-]\s*([A-Z]{3})\b/);
    const priceNum = dollars?.[1]?.replace(/,/g, "");
    const price = priceNum ? `$${Number(priceNum).toLocaleString("en-US")}` : text.match(/\$[\d,]+/)?.[0] || null;
    const depart = times?.[2] || null;
    return {
      index,
      airline,
      depart,
      arrive: times?.[5] || null,
      departDay: times?.[3] || null,
      arriveDay: times?.[6] || null,
      fromAirport: times?.[1] || null,
      toAirport: times?.[4] || null,
      from: route?.[1] || null,
      to: route?.[2] || null,
      price,
      trip,
      stops,
      duration,
      usWorkHours: this.isUsWorkHours(depart),
      label: label.slice(0, 280),
    };
  }

  parseExplore(el, index) {
    const label = bsc.clean(el.getAttribute("aria-label") || el.textContent || "");
    const city = label.match(/^([A-Za-z .'-]+?)(?:\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)|\s+\$)/i)?.[1] || null;
    const dates = label.match(/\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[^$]*?)\s+(?:Nonstop|\d+\s*stops?)/i)?.[1] || null;
    const stops = label.match(/\b(Nonstop|\d+\s*stops?)\b/i)?.[1] || null;
    const duration = label.match(/(\d+\s*hr(?:\s*\d+\s*min)?)/i)?.[1] || null;
    const price = label.match(/\$[\d,]+/)?.[0] || null;
    return { index, city, dates, stops, duration, price, label: label.slice(0, 200) };
  }

  parseOffers() {
    return this.offerLinks().map((el, i) => this.parseOffer(el, i));
  }

  parseDestinations() {
    return this.exploreCards().map((el, i) => this.parseExplore(el, i));
  }

  currentSort() {
    const selected = [...document.querySelectorAll("[role='tab']")].find(
      (el) => el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-checked") === "true"
    );
    const name = bsc.clean(selected?.getAttribute("aria-label") || selected?.textContent || "");
    if (/^cheapest/i.test(name)) return "cheapest";
    if (/^fastest/i.test(name)) return "fastest";
    if (/^best/i.test(name)) return "best";
    return name ? name.split(/\s+/)[0].toLowerCase() : null;
  }

  pageKind() {
    if (this.offerLinks().length) {
      if (/returning flights/i.test(document.body?.innerText || "")) return "returning";
      return "results";
    }
    if (/\/travel\/explore/i.test(location.href) || /\|\s*Explore\s*$/i.test(document.title)) return "explore";
    if (/top (departing|returning) flights/i.test(document.body?.innerText || "")) return "results";
    if (/google\.com\/travel\/flights/i.test(location.href)) return "home";
    if (/google\.com\/travel/i.test(location.href)) return "other";
    return "other";
  }

  isStillLoading() {
    if (this.offerLinks().length || this.exploreCards().length) return false;
    const t = document.body?.innerText || "";
    return /loading results|fetching results/i.test(t);
  }

  async waitForResults(tries = 25) {
    await this.dismissOverlays();
    for (let i = 0; i < tries; i += 1) {
      if (this.offerLinks().length || this.exploreCards().length) return true;
      const t = document.body?.innerText || "";
      if (/no matching flights|couldn['’]t find any flights/i.test(t) && i > 4) return false;
      await bsc.sleep(400);
    }
    return this.offerLinks().length > 0 || this.exploreCards().length > 0;
  }

  sortTab(how) {
    const key = String(how || "cheapest").toLowerCase();
    const want = { cheapest: "cheapest", cheap: "cheapest", price: "cheapest", best: "best", fastest: "fastest", fast: "fastest", duration: "fastest" }[key];
    if (!want) throw new Error(`Unknown sort "${how}". Use cheapest, best, or fastest.`);
    const tabs = [...document.querySelectorAll("[role='tab']")];
    const tab = tabs.find((el) => new RegExp(`^${want}\\b`, "i").test(bsc.clean(el.getAttribute("aria-label") || el.textContent || "")));
    return { want, tab };
  }

  async sort(how = "cheapest") {
    if (!(await this.waitForResults())) {
      throw new Error("No Google Flights results on this tab. Run plugin.google-flights search first.");
    }
    const { want, tab } = this.sortTab(how);
    if (!tab) throw new Error(`No "${want}" sort tab on this page`);
    const selected = tab.getAttribute("aria-selected") === "true" || tab.getAttribute("aria-checked") === "true";
    if (selected) {
      return { sort: want, applied: false, count: this.offerLinks().length };
    }
    tab.scrollIntoView({ block: "center" });
    bsc.click(tab);
    await bsc.sleep(1200);
    return { sort: this.currentSort() || want, applied: true, count: this.offerLinks().length };
  }

  async results(...extra) {
    if (extra.length) {
      throw new Error("results does not take a sort order. Run plugin.google-flights sort cheapest, then results.");
    }
    if (!(await this.waitForResults())) {
      throw new Error(
        `This tab is not showing Google Flights results (${this.pageKind()}: ${location.href}). Run plugin.google-flights search first.`
      );
    }
    await bsc.sleep(400);
    if (this.offerLinks().length) {
      const flights = this.parseOffers();
      return {
        url: location.href,
        title: document.title,
        kind: this.pageKind(),
        count: flights.length,
        sort: this.currentSort(),
        flights,
      };
    }
    const destinations = this.parseDestinations();
    return {
      url: location.href,
      title: document.title,
      kind: "explore",
      count: destinations.length,
      sort: null,
      destinations,
    };
  }

  resolveOffer(which, flights) {
    const asInt = Number(which);
    if (String(which).trim() !== "" && Number.isInteger(asInt) && asInt >= 0 && String(asInt) === String(which).trim()) {
      if (!flights[asInt]) throw new Error(`No offer at index ${asInt} (page has ${flights.length})`);
      return asInt;
    }
    const words = String(which).toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) throw new Error("select needs an index or words to match");
    const hits = flights.filter((f) => words.every((w) => (f.label || "").toLowerCase().includes(w)));
    if (!hits.length) throw new Error(`No offer matches "${which}". Run results.`);
    if (hits.length > 1) {
      throw new Error(`"${which}" matches ${hits.length} offers (indexes ${hits.map((f) => f.index).join(", ")}). Add words or use an index.`);
    }
    return hits[0].index;
  }

  async select(...which) {
    await this.dismissOverlays();
    const needle = which.join(" ");
    if (this.exploreCards().length && !this.offerLinks().length) {
      const dests = this.parseDestinations();
      const i = this.resolveOffer(needle, dests.map((d) => ({ ...d, label: d.label })));
      const el = this.exploreCards()[i];
      el.scrollIntoView({ block: "center", behavior: "instant" });
      bsc.click(el);
      return { selected: dests[i], kind: "explore", url: location.href };
    }
    const flights = this.parseOffers();
    if (!flights.length) throw new Error("No flight offers on this page. Run plugin.google-flights results first.");
    const i = this.resolveOffer(needle, flights);
    const el = this.offerLinks()[i];
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    await bsc.sleep(150);
    bsc.click(el);
    for (let n = 0; n < 20; n += 1) {
      await bsc.sleep(400);
      if (/returning flights|select returning/i.test(document.body?.innerText || "")) break;
    }
    return {
      selected: flights[i],
      url: location.href,
      title: document.title,
      returning: /returning flights/i.test(document.body?.innerText || ""),
    };
  }

  async more(max) {
    const limit = Number(max) || 5;
    let clicks = 0;
    for (; clicks < limit; clicks += 1) {
      const btn = [...document.querySelectorAll("button, [role='button']")].find((b) =>
        /^view more flights$/i.test(bsc.clean(b.textContent))
      );
      if (!btn) break;
      const before = this.offerLinks().length;
      btn.scrollIntoView({ block: "center", behavior: "instant" });
      bsc.click(btn);
      let grew = false;
      for (let i = 0; i < 15; i += 1) {
        await bsc.sleep(400);
        if (this.offerLinks().length > before) {
          grew = true;
          break;
        }
      }
      if (!grew) break;
    }
    return { clicks, count: this.offerLinks().length };
  }

  async stops(which = "nonstop") {
    await this.dismissOverlays();
    const w = String(which || "nonstop").toLowerCase();
    const label =
      /^(any|all)$/.test(w) ? "any" : /^(0|non)/.test(w) ? "nonstop" : /^1/.test(w) ? "1 stop" : /^2/.test(w) ? "2" : w;
    const filter = [...document.querySelectorAll("button, [role='button']")].find((el) =>
      /^stops\b/i.test(bsc.clean(el.getAttribute("aria-label") || el.textContent || ""))
    );
    if (!filter) throw new Error("No Stops filter on this page");
    bsc.click(filter);
    await bsc.sleep(400);
    const opt = [...document.querySelectorAll("button, [role='option'], [role='radio'], label, li")].find((el) => {
      const t = bsc.clean(el.textContent);
      if (/^any(\s|$)/i.test(label)) return /^any\b/i.test(t);
      if (label === "nonstop") return /^nonstop\b/i.test(t);
      if (label === "1 stop") return /^1\s*stop or fewer|^1\s*stop\b/i.test(t);
      return t.toLowerCase().includes(label);
    });
    if (!opt) throw new Error(`No Stops option matching "${which}"`);
    bsc.click(opt);
    await bsc.sleep(1000);
    return { stops: which, count: this.offerLinks().length };
  }

  async status() {
    const { dismissed } = await this.dismissOverlays();
    return {
      overlaysDismissed: dismissed,
      url: location.href,
      title: document.title,
      kind: this.pageKind(),
      sort: this.currentSort(),
      resultCount: this.offerLinks().length,
      destinationCount: this.exploreCards().length,
    };
  }
}
