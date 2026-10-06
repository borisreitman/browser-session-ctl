// Built-in plugin: search Expedia flights and read the results list.
//
//   browser-session-ctl --tab <id> plugin.expedia search SEA SFO 2026-10-12 2026-10-19
//   browser-session-ctl --tab <id> plugin.expedia search SEA SFO 2026-10-12
//   browser-session-ctl --tab <id> plugin.expedia search SEA SFO 2026-10-12 2026-10-19 business 2
//   browser-session-ctl --tab <id> plugin.expedia sort cheapest
//   browser-session-ctl --tab <id> plugin.expedia sort earliest
//   browser-session-ctl --tab <id> plugin.expedia leave evening
//   browser-session-ctl --tab <id> plugin.expedia refresh
//   browser-session-ctl --tab <id> plugin.expedia results
//   browser-session-ctl --tab <id> plugin.expedia select 0
//   browser-session-ctl --tab <id> plugin.expedia status
//
// Expedia's origin/destination widgets are custom typeaheads (not native
// inputs), so filling the homepage form from a plugin is brittle. The
// Flights-Search URL is what the site itself uses after you click Search,
// and loading it lands on the same results UI — so that's how `search`
// drives the tab. `results` / `select` then read the rendered cards.
class Plugin {
  help() {
    return {
      namespace: "expedia",
      methods: {
        help: "Show this message.",
        search:
          "search <from> <to> <depart> [return] [cabin] [adults] — open Expedia flight results, cheapest first (Price: low to high). Airport codes (SEA, SFO). Dates as YYYY-MM-DD or MM/DD/YYYY. Omit return (or pass oneway) for one-way. cabin: economy | premium | business | first. After the page loads, sort cheapest (default) then results.",
        sort:
          "sort [cheapest|expensive|recommended|duration|longest|earliest|latest|earliest-arrival|latest-arrival] — set Sort by. Default: cheapest (Price: low to high). Clicks Refresh search first if the stale-price overlay is up.",
        leave:
          "leave <early-morning|morning|afternoon|evening> — toggle the left-rail Departure time filter (origin local time). evening is 6:00pm–11:59pm. Repeat to uncheck. Clicks Refresh search first if the stale-price overlay is up.",
        refresh:
          "refresh — click Expedia's 'Refresh search' dialog if it is covering the results (stale prices). No-op if the overlay is not showing.",
        results:
          "results — dismiss the stale-price overlay if it is up, wait for the flight list, return structured offers in the page's current Sort by order. Does not change sort; use sort for that.",
        select:
          "select <index|text...> [fare] — click one offer (0-based index, or words matched against the offer label, e.g. select \"8:10pm air canada\"), then choose a fare (default: cheapest, e.g. Basic; or name one: select 3 Standard). Waits for the fare sheet and the next stage. Does not change sort.",
        open: "open <index|text...> — click one offer and return the fare sheet (fares) without choosing one.",
        fares: "fares — list fares in the open fare sheet (name, price).",
        fare: "fare <name> — click a fare in the open fare sheet (Basic, Standard, Flex, Comfort, ...). Waits for the next stage (returning flights or trip details).",
        more: "more [max] — click 'Show More Flights' until the list stops growing (or max clicks, default 10). Then results returns the longer list.",
        facets: "facets — list every left-rail checkbox filter: group, label, checked.",
        facet: "facet <group> <label> [on|off] — set a left-rail checkbox filter by substring, e.g. facet stops nonstop on; facet airlines swiss on; facet layover zurich off. Omit on|off to toggle.",
        stops: "stops <nonstop|1|2> [on|off] — sugar for facet stops.",
        airline: "airline <name> [on|off] — sugar for facet airlines.",
        arrive: "arrive <early-morning|morning|afternoon|evening> — toggle Arrival time bucket (destination local time), if the left rail has one.",
        carsearch:
          "carsearch <airport> <pickup-date> <dropoff-date> [pickup-time] [dropoff-time] — open Expedia rental car results (expedia.com/carsearch). Airport IATA code (LCA, PFO). Dates YYYY-MM-DD or MM/DD/YYYY. Times 10:00 or 10:30am (default 10:00). Then carResults.",
        carResults: "carResults [max] — wait for the car list, return cars (class, model, supplier, total, perDay, passengers, transmission, freeCancellation, rating).",
        carFacets: "carFacets — list the left-rail car filters: group, label (with count), checked.",
        carFacet: "carFacet <label> [on|off] — set a car filter by label, e.g. carFacet van on; carFacet minivan on; carFacet automatic on.",
        carSort: "carSort [price|rating|recommended] — set Sort by (default: price, Total price low to high).",
        status: "status — what this tab is showing: home, results, or other, plus the form values. Dismisses the stale-price overlay first.",
      },
    };
  }

  toExpediaDate(value) {
    if (!value) return null;
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value)) {
      const [m, d, y] = value.split("/").map(Number);
      return `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`;
    }
    const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!iso) throw new Error(`Unrecognized date "${value}". Use YYYY-MM-DD or MM/DD/YYYY.`);
    return `${iso[2].padStart(2, "0")}/${iso[3].padStart(2, "0")}/${iso[1]}`;
  }

  airport(value) {
    const code = String(value || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) {
      throw new Error(`"${value}" is not a 3-letter airport code (e.g. SEA, SFO, JFK).`);
    }
    return code;
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
    const params = {
      from: this.airport(from),
      to: this.airport(to),
      depart: this.toExpediaDate(depart),
      returnDate: null,
      trip: "oneway",
      cabin: "economy",
      adults: 1,
    };
    for (const token of rest) {
      if (token == null || token === "") continue;
      const lower = String(token).toLowerCase();
      if (bsc.dates.looksLikeDate(token)) {
        params.returnDate = this.toExpediaDate(token);
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
        if (params.adults < 1 || params.adults > 6) {
          throw new Error("adults must be between 1 and 6");
        }
        continue;
      }
      params.cabin = this.cabinClass(token);
    }
    if (params.trip === "roundtrip" && !params.returnDate) {
      throw new Error("roundtrip search needs a return date");
    }
    return params;
  }

  searchUrl(params) {
    const leg1 = `from:${params.from},to:${params.to},departure:${params.depart}TANYT`;
    const search = new URLSearchParams();
    search.set("trip", params.trip);
    search.set("leg1", leg1);
    if (params.trip === "roundtrip") {
      search.set("leg2", `from:${params.to},to:${params.from},departure:${params.returnDate}TANYT`);
    }
    search.set("passengers", `adults:${params.adults},children:0,infantinlap:N`);
    search.set("mode", "search");
    search.set("options", `cabinclass:${params.cabin}`);
    search.set("sortType", "PRICE");
    search.set("sortOrder", "INCREASING");
    return `https://www.expedia.com/Flights-Search?${search.toString()}`;
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

  fieldValue(labelRe) {
    const inputs = [...document.querySelectorAll("input, textarea, [role='combobox']")];
    const match = inputs.find((el) => {
      const name = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`;
      return labelRe.test(name);
    });
    return (match?.value || match?.getAttribute("value") || "").trim() || null;
  }

  buttonName(labelRe) {
    const buttons = [...document.querySelectorAll("button, [role='button']")];
    const match = buttons.find((el) => labelRe.test(el.getAttribute("aria-label") || el.textContent || ""));
    const name = (match?.getAttribute("aria-label") || match?.textContent || "").replace(/\s+/g, " ").trim();
    return name || null;
  }

  pageKind() {
    const url = location.href;
    if (/\/Flights-Search/i.test(url) || document.querySelector("h2, h3, [role='heading']")?.textContent?.includes("Departing flights")) {
      if (this.offerButtons().length || /Departing flights/i.test(document.body?.innerText || "")) {
        return "results";
      }
    }
    if (/expedia\.com\/?(\?|$)/i.test(url) || /\/Flights\/?$/i.test(url)) return "home";
    return "other";
  }

  offerName(el) {
    const raw = el.getAttribute("aria-label") || el.innerText || el.textContent || "";
    return raw.replace(/\s+/g, " ").trim();
  }

  isOfferLabel(name) {
    return /^(?:Cheapest,\s*)?Select(?: and show fare information for)?\s+.+\s+flight,/i.test(name);
  }

  offerButtons() {
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll("button, [role='button']")) {
      const name = this.offerName(el);
      if (!this.isOfferLabel(name)) continue;
      const key = name.slice(0, 180);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(el);
    }
    return out;
  }

  parseOffer(el, index) {
    const name = this.offerName(el).replace(/^Cheapest,\s*/i, "");
    const parsed = name.match(
      /^Select(?: and show fare information for)?\s+(.+?)\s+flight,\s+departing at\s+(\d{1,2}:\d{2}\s*(?:am|pm))(?:\s+from\s+[^,]+)?,?\s+arriving at\s+(\d{1,2}:\d{2}\s*(?:am|pm))(?:\s+in\s+[^,]+)?,?/i
    );
    const pricedAt = name.match(/[Pp]riced at\s+(\$[\d,]+)/);
    const extraTotal = name.match(/additional\s+(\$[\d,]+)\s+and total\s+(\$[\d,]+)/i);
    const stops = name.match(/\b(Nonstop|One stop|\d+\s*stops?)\b/i)?.[1] || null;
    const layover = name.match(/Layover for ([^.]+)\./i)?.[1]?.trim() || null;
    const card = el.closest(
      "[data-test-id='offer-listing'], [data-test-id='flight-card'], li, [class*='uitk-card']"
    );
    const cardText = (card?.innerText || el.innerText || "").replace(/\s+/g, " ").trim();
    const duration = cardText.match(/(\d+h(?:\s*\d+m)?)\s*•/i)?.[1] || null;
    const route = cardText.match(/([A-Za-z .]+ \(\w{3}\))\s*-\s*([A-Za-z .]+ \(\w{3}\))/) || null;
    const extra = extraTotal?.[1] || null;
    const trip = name.match(/\b(Roundtrip|One(?:-|\s)?way)\b/i)?.[1] || null;
    const depart = parsed?.[2] || null;
    return {
      index,
      airline: parsed?.[1]?.replace(/^multiple/i, "Multiple ") || null,
      depart,
      arrive: parsed?.[3] || null,
      price: pricedAt?.[1] || extraTotal?.[2] || null,
      extra,
      trip,
      stops,
      layover,
      duration,
      from: route?.[1]?.trim() || null,
      to: route?.[2]?.trim() || null,
      usWorkHours: this.isUsWorkHours(depart),
      label: this.offerName(el).slice(0, 240),
    };
  }

  hour24(t) {
    const m = String(t || "").match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
    if (!m) return null;
    let h = Number(m[1]) % 12;
    if (/pm/i.test(m[3])) h += 12;
    return h + Number(m[2]) / 60;
  }

  // Origin-local wall clock. 9:00am–5:00pm is a typical US workday.
  isUsWorkHours(t) {
    const h = this.hour24(t);
    if (h == null) return null;
    return h >= 9 && h < 17;
  }

  sortControl() {
    const labelled = document.querySelector('select[aria-label="Sort by"], [aria-label="Sort by"]');
    if (labelled) return labelled;
    const lab = [...document.querySelectorAll("label")].find((el) => /^\s*Sort by\s*$/i.test(el.textContent));
    if (lab?.htmlFor) {
      const byId = document.getElementById(lab.htmlFor);
      if (byId) return byId;
    }
    const combos = [...document.querySelectorAll("select, [role='combobox']")];
    return (
      combos.find((el) => {
        const name = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("name") || ""}`;
        return /sort/i.test(name);
      })
      || combos.find((el) => {
        const l = el.id && document.querySelector(`label[for="${el.id}"]`);
        return l && /sort by/i.test(l.textContent);
      })
      || null
    );
  }

  currentSortLabel() {
    const control = this.sortControl();
    if (!control) return "";
    if (control.tagName === "SELECT") {
      return (control.selectedOptions?.[0]?.textContent || "").trim();
    }
    return (control.getAttribute("value") || control.getAttribute("aria-valuetext") || control.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  sortAliases() {
    return {
      cheapest: "Price: low to high",
      price: "Price: low to high",
      cheap: "Price: low to high",
      "low-to-high": "Price: low to high",
      "price-low": "Price: low to high",
      expensive: "Price: high to low",
      "high-to-low": "Price: high to low",
      "price-high": "Price: high to low",
      recommended: "Recommended",
      duration: "Shortest duration",
      shortest: "Shortest duration",
      "shortest-duration": "Shortest duration",
      longest: "Longest duration",
      "longest-duration": "Longest duration",
      earliest: "Earliest departure",
      "earliest-departure": "Earliest departure",
      latest: "Latest departure",
      "latest-departure": "Latest departure",
      "earliest-arrival": "Earliest arrival",
      "arrive-early": "Earliest arrival",
      "latest-arrival": "Latest arrival",
      "arrive-late": "Latest arrival",
    };
  }

  sortUsage() {
    return "cheapest, expensive, recommended, duration, longest, earliest, latest, earliest-arrival, latest-arrival";
  }

  sortLabel(how) {
    const raw = String(how == null || how === "" ? "cheapest" : how).trim();
    const key = raw.toLowerCase().replace(/[_\s]+/g, "-");
    const aliases = this.sortAliases();
    if (aliases[key]) return aliases[key];
    const lower = raw.toLowerCase();
    const labels = [...new Set(Object.values(aliases))];
    const exact = labels.find((label) => label.toLowerCase() === lower);
    if (exact) return exact;
    throw new Error(`Unknown sort "${how}". Use ${this.sortUsage()}.`);
  }

  sortMatches(label) {
    const current = this.currentSortLabel().toLowerCase();
    const wanted = String(label).toLowerCase();
    return Boolean(current) && (current === wanted || current.includes(wanted));
  }

  async applySort(label) {
    const control = this.sortControl();
    if (!control) throw new Error('No "Sort by" control on this page');
    control.scrollIntoView({ block: "center", inline: "nearest" });
    let applied;
    if (control.tagName === "SELECT") {
      applied = await bsc.reactSelect(control, label, { partial: true });
    } else {
      bsc.fireClick(control);
      await bsc.sleep(250);
      const opts = [...document.querySelectorAll('[role="option"], option, li')];
      const wanted = label.toLowerCase();
      const opt =
        opts.find((el) => el.textContent.trim().toLowerCase() === wanted) ||
        opts.find((el) => el.textContent.trim().toLowerCase().includes(wanted));
      if (!opt) throw new Error(`Could not find sort option "${label}"`);
      bsc.fireClick(opt);
      applied = opt.textContent.trim();
    }
    await bsc.sleep(600);
    return { sort: applied, count: this.parseOffers().length };
  }

  async sort(how = "cheapest") {
    await this.dismissStalePrices();
    const label = this.sortLabel(how);
    if (this.sortMatches(label)) {
      return { sort: this.currentSortLabel() || label, applied: false, count: this.parseOffers().length };
    }
    return { ...(await this.applySort(label)), applied: true };
  }

  departureTimeRoot() {
    const heading = [...document.querySelectorAll("h2, h3, h4, legend, [role='heading'], p, span, div")].find(
      (el) => /^departure time\b/i.test(el.textContent.trim().slice(0, 40))
    );
    return heading?.closest("fieldset, [class*='filter'], [data-test-id], section, div") || document.body;
  }

  leaveControl(when) {
    const key = String(when || "").toLowerCase().replace(/[_ ]+/g, "-");
    const matchers = {
      "early-morning": /early\s*morning\s*\(/i,
      morning: /(?:^|[^y]\s)morning\s*\(5:00am/i,
      afternoon: /afternoon\s*\(/i,
      evening: /evening\s*\(/i,
      night: /evening\s*\(/i,
    };
    const re = matchers[key];
    if (!re) {
      throw new Error(
        'leave <early-morning|morning|afternoon|evening> — Expedia\'s night bucket is "evening" (6:00pm–11:59pm).'
      );
    }
    const labels = [...document.querySelectorAll("label")];
    // Prefer the origin "Departure time in …" group, not arrival time.
    const departLabels = labels.filter((el) => {
      const block = (el.closest("fieldset, section, div")?.innerText || "").slice(0, 400);
      return /departure time in/i.test(block);
    });
    const pool = departLabels.length ? departLabels : labels;
    return (
      pool.find((el) => re.test((el.textContent || "").replace(/\s+/g, " ")))
      || labels.find((el) => re.test((el.textContent || "").replace(/\s+/g, " ")))
      || null
    );
  }

  async leave(when) {
    await this.dismissStalePrices();
    const el = this.leaveControl(when);
    if (!el) {
      throw new Error(
        `No left-rail Departure time control for "${when}". Scroll the filters or run this on a results page.`
      );
    }
    const clickable = el.closest("label") || el.querySelector("input") || el;
    clickable.scrollIntoView({ block: "center", inline: "nearest" });
    await bsc.sleep(100);
    const input = el.tagName === "INPUT" ? el : el.querySelector("input[type='checkbox'], input[type='radio']");
    const before = input ? input.checked : null;
    if (input) {
      await bsc.waitFor(() => !input.disabled, 40, 250);
      await bsc.reactClick(input);
    } else bsc.fireClick(clickable);
    await bsc.sleep(800);
    const after = input ? input.checked : null;
    return {
      leave: when,
      label: (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
      checked: after,
      wasChecked: before,
      count: this.parseOffers().length,
    };
  }

  parseOffers() {
    return this.offerButtons().map((el, index) => this.parseOffer(el, index));
  }

  filters() {
    const text = document.body?.innerText || "";
    const stops = [...text.matchAll(/((?:Nonstop|1 Stop|2\+ Stops) \(\d+\))\s*(\$[\d,]+)/g)].map((m) => ({
      label: m[1],
      from: m[2],
    }));
    return { stops: stops.slice(0, 3) };
  }

  isStillLoading() {
    if (this.offerButtons().length) return false;
    const heading = document.querySelector("[class*='progress'], [aria-busy='true']");
    return Boolean(heading);
  }

  // Expedia pops "Please refresh your search for the latest prices" over the
  // results list. Cards behind it are stale — never read or click them.
  stalePriceRefreshButton() {
    const buttons = [...document.querySelectorAll("button, [role='button'], a")];
    return (
      buttons.find((el) => /^\s*refresh search\s*$/i.test((el.textContent || "").replace(/\s+/g, " ").trim())) || null
    );
  }

  hasStalePriceOverlay() {
    if (this.stalePriceRefreshButton()) return true;
    return /please refresh your search for the latest prices/i.test(document.body?.innerText || "");
  }

  async dismissStalePrices() {
    if (!this.hasStalePriceOverlay()) return { refreshed: false };
    const btn = this.stalePriceRefreshButton();
    if (!btn) {
      throw new Error(
        'Expedia is showing "Please refresh your search for the latest prices" but no "Refresh search" button was found.'
      );
    }
    // Plain DOM events: the stale-price overlay could not be reproduced to confirm it has a React handler.
    bsc.fireClick(btn);
    for (let i = 0; i < 25; i += 1) {
      await bsc.sleep(400);
      if (!this.hasStalePriceOverlay()) return { refreshed: true };
    }
    throw new Error('Clicked "Refresh search" but the stale-price overlay is still showing.');
  }

  async refresh() {
    return this.dismissStalePrices();
  }

  async results(...extra) {
    if (extra.length) {
      throw new Error(
        `results does not take a sort order. Run plugin.expedia sort cheapest (or ${this.sortUsage()}), then results.`
      );
    }
    const { refreshed } = await this.dismissStalePrices();
    for (let i = 0; i < 12; i += 1) {
      if (this.hasStalePriceOverlay()) {
        throw new Error(
          'Expedia stale-price overlay is showing. Click "Refresh search" (or retry results) before reading offers.'
        );
      }
      const flights = this.parseOffers();
      if (flights.length) {
        return {
          url: location.href,
          title: document.title,
          count: flights.length,
          refreshed,
          sort: this.currentSortLabel() || null,
          filters: this.filters(),
          flights,
        };
      }
      if (!this.isStillLoading() && i > 2) break;
      await bsc.sleep(400);
    }
    const kind = this.pageKind();
    if (kind !== "results") {
      throw new Error(
        `This tab is not showing Expedia flight results (${kind}: ${location.href}). Run plugin.expedia search first.`
      );
    }
    throw new Error("Timed out waiting for Expedia flight results to render.");
  }

  // ---- left-rail checkbox filters (stops, airlines, layover airport, ...) ----
  groupOf(input) {
    let node = input.parentElement;
    for (let i = 0; node && i < 8; i += 1, node = node.parentElement) {
      const h = [...node.querySelectorAll("legend, h2, h3, h4, [role='heading']")].find(
        (x) => !x.closest("label") && !x.contains(input)
      );
      if (h) return (h.textContent || "").replace(/\s+/g, " ").trim();
    }
    return "";
  }

  facetInputs() {
    return [...document.querySelectorAll("input[type='checkbox']")].map((input) => {
      const label = input.closest("label") || (input.id && document.querySelector(`label[for="${input.id}"]`));
      const text = ((label && label.textContent) || input.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      return { input, label: text, group: this.groupOf(input), checked: input.checked };
    });
  }

  facets() {
    return {
      facets: this.facetInputs().map((f) => ({ group: f.group, label: f.label, checked: f.checked })),
    };
  }

  async facet(group, label, state) {
    if (!group || !label) throw new Error("facet <group> <label> [on|off]");
    await this.dismissStalePrices();
    const g = String(group).toLowerCase();
    const l = String(label).toLowerCase();
    const hit = this.facetInputs().filter((f) => f.group.toLowerCase().includes(g) && f.label.toLowerCase().includes(l));
    if (!hit.length) throw new Error(`No filter checkbox matches group "${group}" label "${label}". Run facets.`);
    if (hit.length > 1) {
      throw new Error(`Ambiguous: ${hit.map((f) => `${f.group}/${f.label}`).join(" | ")}. Be more specific.`);
    }
    const want = state === undefined ? !hit[0].checked : /^(on|true|1|yes)$/i.test(String(state));
    if (hit[0].checked !== want) {
      hit[0].input.scrollIntoView({ block: "center", behavior: "instant" });
      // Expedia disables every filter while it reloads the list.
      await bsc.waitFor(() => !hit[0].input.disabled, 40, 250);
      await bsc.reactClick(hit[0].input);
      await this.settle();
    }
    const key = (t) => t.replace(/\s*\(\d+\).*$/, "");
    const after = this.facetInputs().find((f) => f.group === hit[0].group && key(f.label) === key(hit[0].label));
    return { group: hit[0].group, label: hit[0].label, checked: after ? after.checked : null };
  }

  // Wait until the offer list stops changing (filters re-render the list async).
  async settle() {
    await bsc.sleep(800);
    let last = "";
    let stable = 0;
    for (let i = 0; i < 30 && stable < 3; i += 1) {
      const sig = this.offerButtons().map((el) => this.offerName(el)).join("|") + (this.hasStalePriceOverlay() ? "!" : "");
      stable = sig === last ? stable + 1 : 0;
      last = sig;
      await bsc.sleep(400);
    }
  }

  stops(which, state) {
    const w = String(which || "").toLowerCase();
    const label = /^(0|non)/.test(w) ? "nonstop" : /^1/.test(w) ? "1 stop" : /^2/.test(w) ? "2+" : w;
    return this.facet("stop", label, state);
  }

  airline(name, state) {
    return this.facet("airline", name, state);
  }

  arrive(when) {
    const w = String(when || "").toLowerCase().replace(/[ _]/g, "-");
    const map = { "early-morning": "early morning", morning: "morning", afternoon: "afternoon", evening: "evening", night: "evening" };
    if (!map[w]) throw new Error("arrive <early-morning|morning|afternoon|evening>");
    return this.facet("arrival", map[w]);
  }

  // ---- longer list ----
  async more(max) {
    const limit = Number(max) || 10;
    let clicks = 0;
    for (; clicks < limit; clicks += 1) {
      const btn = [...document.querySelectorAll("button")].find((b) => /^show more( flights)?$/i.test((b.textContent || "").replace(/\s+/g, " ").trim()));
      if (!btn) break;
      const before = this.offerButtons().length;
      btn.scrollIntoView({ block: "center", behavior: "instant" });
      await bsc.reactClick(btn);
      let grew = false;
      for (let i = 0; i < 15; i += 1) {
        await bsc.sleep(400);
        if (this.offerButtons().length > before) {
          grew = true;
          break;
        }
      }
      if (!grew) break;
    }
    return { clicks, count: this.offerButtons().length };
  }

  // ---- offer -> fare sheet -> next stage ----
  fareButtons() {
    return [...document.querySelectorAll("button, [role='button']")]
      .map((el) => {
        const t = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
        const m = t.match(/^Select (.+?) for (\$[\d,]+(?:\.\d+)?)/i);
        return m ? { el, name: m[1], price: m[2] } : null;
      })
      .filter(Boolean);
  }

  resolveOffer(which, flights) {
    const asInt = Number(which);
    if (String(which).trim() !== "" && Number.isInteger(asInt) && asInt >= 0 && String(asInt) === String(which).trim()) {
      if (!flights[asInt]) throw new Error(`No offer at index ${asInt} (page has ${flights.length})`);
      return asInt;
    }
    const words = String(which).toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) throw new Error("select/open needs an index or words to match");
    const hits = flights.filter((f) => words.every((w) => f.label.toLowerCase().includes(w)));
    if (!hits.length) throw new Error(`No offer matches "${which}". Run more/results.`);
    if (hits.length > 1) {
      throw new Error(`"${which}" matches ${hits.length} offers (indexes ${hits.map((f) => f.index).join(", ")}). Add words or use an index.`);
    }
    return hits[0].index;
  }

  async open(...which) {
    await this.dismissStalePrices();
    const flights = this.parseOffers();
    if (!flights.length) throw new Error("No flight offers on this page. Run plugin.expedia results first.");
    const i = this.resolveOffer(which.join(" "), flights);
    const el = this.offerButtons()[i];
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    await bsc.sleep(150);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (el instanceof HTMLElement) el.focus({ preventScroll: true });
      await bsc.reactClick(el);
      for (let n = 0; n < 10; n += 1) {
        await bsc.sleep(400);
        if (this.fareButtons().length || /returning flights/i.test(document.body?.innerText || "")) {
          return { selected: flights[i], fares: this.fareButtons().map((f) => ({ name: f.name, price: f.price })) };
        }
      }
    }
    return { selected: flights[i], fares: [] };
  }

  fares() {
    return { fares: this.fareButtons().map((f) => ({ name: f.name, price: f.price })) };
  }

  async fare(name) {
    const buttons = this.fareButtons();
    if (!buttons.length) throw new Error("No fare sheet is open. Run open <index> first.");
    const want = String(name || "").toLowerCase();
    const hit = want ? buttons.find((b) => b.name.toLowerCase() === want) || buttons.find((b) => b.name.toLowerCase().includes(want)) : buttons[0];
    if (!hit) throw new Error(`No fare "${name}". Available: ${buttons.map((b) => `${b.name} ${b.price}`).join(", ")}`);
    hit.el.scrollIntoView({ block: "center", behavior: "instant" });
    await bsc.reactClick(hit.el);
    for (let n = 0; n < 25; n += 1) {
      await bsc.sleep(400);
      if (/returning flights/i.test(document.body?.innerText || "") || !this.fareButtons().length) break;
    }
    await bsc.sleep(600);
    return {
      fare: { name: hit.name, price: hit.price },
      url: location.href,
      title: document.title,
      returning: /returning flights/i.test(document.body?.innerText || ""),
    };
  }

  async select(which, fareName) {
    if (which === undefined) throw new Error("select <index|text...> [fare]");
    const opened = await this.open(which);
    if (!opened.fares.length) {
      return { ...opened, url: location.href, title: document.title, returning: /returning flights/i.test(document.body?.innerText || "") };
    }
    const picked = await this.fare(fareName);
    return { selected: opened.selected, ...picked };
  }

  async status() {
    const { refreshed } = await this.dismissStalePrices();
    const flights = this.parseOffers();
    return {
      url: location.href,
      title: document.title,
      kind: this.pageKind(),
      staleOverlay: this.hasStalePriceOverlay(),
      refreshed,
      from: this.fieldValue(/leaving from/i),
      to: this.fieldValue(/going to/i),
      dates: this.buttonName(/^Dates\b/i),
      travelers: this.buttonName(/^Travelers/i),
      resultCount: flights.length,
    };
  }

  // ---- Rental cars (expedia.com/carsearch) ----------------------------
  // `carsearch` loads the same URL the Cars form builds on Search. The
  // pick-up place is an airport IATA code; Expedia resolves it ("PFO" ->
  // "Paphos, Cyprus (PFO-Paphos Intl.)"). Everything after that is read
  // from / driven on the rendered results page.

  carTime(value) {
    const m = String(value || "10:00").trim().toLowerCase().match(/^(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?$/);
    if (!m) throw new Error(`Unrecognized time "${value}". Use HH:MM (24h) or 10:30am.`);
    let h = Number(m[1]);
    const min = Number(m[2] || 0);
    if (m[3]) h = (h % 12) + (m[3] === "pm" ? 12 : 0);
    if (h > 23 || ![0, 15, 30, 45].includes(min)) throw new Error(`Time "${value}" must be on a 15-minute step.`);
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${String(h12).padStart(2, "0")}${String(min).padStart(2, "0")}${h >= 12 ? "PM" : "AM"}`;
  }

  carSearchUrl(place, pickup, dropoff, pickupTime, dropoffTime) {
    const code = this.airport(place);
    const d1 = this.toExpediaDate(pickup);
    const d2 = this.toExpediaDate(dropoff);
    const iso = (d) => {
      const [m, day, y] = d.split("/");
      return `${y}-${m}-${day}`;
    };
    const search = new URLSearchParams();
    search.set("locn", code);
    search.set("pickupIATACode", code);
    search.set("d1", iso(d1));
    search.set("d2", iso(d2));
    search.set("date1", d1);
    search.set("date2", d2);
    search.set("time1", this.carTime(pickupTime));
    search.set("time2", this.carTime(dropoffTime || pickupTime));
    return `https://www.expedia.com/carsearch?${search.toString()}`;
  }

  carsearch(place, pickup, dropoff, pickupTime, dropoffTime) {
    if (!place || !pickup || !dropoff) {
      throw new Error("usage: carsearch <airport> <pickup-date> <dropoff-date> [pickup-time] [dropoff-time]");
    }
    const url = this.carSearchUrl(place, pickup, dropoff, pickupTime, dropoffTime);
    setTimeout(() => location.assign(url), 50);
    return { url };
  }

  // One element per car. The card wrapper is data-stid="lodging-card-responsive";
  // fall back to the nearest ancestor that carries the hidden "Reserve Item, ..." label.
  carCards() {
    const cards = [];
    for (const btn of document.querySelectorAll("button, a")) {
      if ((btn.innerText || "").trim() !== "Reserve") continue;
      let el = btn.closest('[data-stid="lodging-card-responsive"]');
      for (let n = btn.parentElement; !el && n; n = n.parentElement) {
        if (/Reserve Item, /.test(n.innerText || "") && (n.innerText.match(/Reserve Item, /g) || []).length === 1) el = n;
      }
      if (el && !cards.includes(el)) cards.push(el);
    }
    return cards;
  }

  parseCar(el, index) {
    const text = (el.innerText || "").replace(/ /g, " ");
    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
    const reserve = text.match(/Reserve Item, (.+?) from (.+?) at \$([\d,]+) total/);
    const iClass = reserve ? lines.indexOf(reserve[1]) : -1;
    return {
      index,
      class: reserve?.[1] || null,
      model: iClass >= 0 ? lines[iClass + 1] : null,
      supplier: reserve?.[2] || null,
      total: reserve ? `$${reserve[3]}` : null,
      perDay: text.match(/current price is (\$[\d,]+)/)?.[1] || null,
      passengers: lines.find((l) => /^\d+$/.test(l)) || null,
      transmission: /Automatic/i.test(text) ? "Automatic" : /Manual/i.test(text) ? "Manual" : null,
      freeCancellation: /Free cancellation/i.test(text),
      payAtPickup: /Pay at pick-up/i.test(text),
      rating: text.match(/(\d+(?:\.\d)?) out of 10/)?.[1] || null,
      reviews: text.match(/\((\d+) reviews?\)/)?.[1] || null,
    };
  }

  async carSettle() {
    await bsc.sleep(800);
    let last = "";
    let stable = 0;
    for (let i = 0; i < 30 && stable < 3; i += 1) {
      const sig = this.carCards().map((el) => (el.innerText || "").slice(0, 80)).join("|");
      stable = sig && sig === last ? stable + 1 : 0;
      last = sig;
      await bsc.sleep(400);
    }
  }

  async carResults(max = 20) {
    await bsc.waitFor(() => this.carCards().length > 0, 60, 500);
    await this.carSettle();
    const cars = this.carCards().map((el, i) => this.parseCar(el, i));
    const count = document.body.innerText.match(/^(\d[\d,]*)\s+cars?\b/im)?.[1] || null;
    return {
      url: location.href,
      count: count ? Number(count.replace(/,/g, "")) : null,
      loaded: cars.length,
      cars: cars.slice(0, Number(max) || 20),
    };
  }

  carFilterInputs() {
    return [...document.querySelectorAll("input[type=checkbox]")]
      .filter((i) => /^sel[A-Za-z]+-/.test(i.id))
      .map((input) => {
        const label = (input.closest("label") || document.querySelector(`label[for="${CSS.escape(input.id)}"]`))
          ?.innerText.replace(/\s+/g, " ").trim() || "";
        return { input, group: input.name, label, checked: input.checked };
      });
  }

  carFacets() {
    const seen = new Set();
    const out = [];
    for (const f of this.carFilterInputs()) {
      const key = `${f.group}|${f.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ group: f.group, label: f.label, checked: f.checked });
    }
    return out;
  }

  // carFacet <label> [on|off], e.g. carFacet van on. Match is on the label
  // without its trailing "(n)" count, exact first, then substring.
  async carFacet(label, state) {
    if (!label) throw new Error("usage: carFacet <label> [on|off]");
    const l = String(label).toLowerCase();
    const bare = (f) => f.label.toLowerCase().replace(/\s*\(\d+\)\s*$/, "");
    const all = this.carFilterInputs();
    const exact = all.filter((f) => bare(f) === l);
    const hits = exact.length ? exact : all.filter((f) => bare(f).includes(l));
    const distinct = new Set(hits.map((f) => `${f.group}|${bare(f)}`));
    if (!hits.length) throw new Error(`No car filter matches "${label}". Run carFacets.`);
    if (distinct.size > 1) throw new Error(`Ambiguous: ${[...distinct].join(", ")}. Be more specific.`);
    // some filters appear twice (Popular + Car type); drive the first
    const target = hits[0].input;
    const want = state === undefined ? !target.checked : /^(on|true|1|yes)$/i.test(String(state));
    if (target.checked !== want) {
      target.scrollIntoView({ block: "center", behavior: "instant" });
      await bsc.waitFor(() => !target.disabled, 40, 250);
      await bsc.reactClick(target);
      await this.carSettle();
    }
    return { group: hits[0].group, label: hits[0].label, checked: target.checked };
  }

  // carSort [price|rating|recommended]
  async carSort(how = "price") {
    const select = document.querySelector("select#sort-filter-dropdown-sort, select[name=sort]");
    if (!select) throw new Error('No "Sort by" control on this page');
    const h = String(how).toLowerCase();
    const label = /rat/.test(h) ? "Traveler ratings" : /rec/.test(h) ? "Recommended" : "Total price";
    await bsc.reactSelect(select, label, { partial: true });
    await this.carSettle();
    return { sort: label };
  }
}
