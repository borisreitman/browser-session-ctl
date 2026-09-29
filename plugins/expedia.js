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
        status: "status — what this tab is showing: home, results, or other, plus the form values. Dismisses the stale-price overlay first.",
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
      clientX: rect.left + Math.max(rect.width / 2, 1),
      clientY: rect.top + Math.max(rect.height / 2, 1),
      button: 0,
    };
    target.dispatchEvent(new PointerEvent("pointerdown", opts));
    target.dispatchEvent(new MouseEvent("mousedown", opts));
    target.dispatchEvent(new PointerEvent("pointerup", opts));
    target.dispatchEvent(new MouseEvent("mouseup", opts));
    target.dispatchEvent(new MouseEvent("click", opts));
  }

  looksLikeDate(value) {
    return /^\d{4}-\d{1,2}-\d{1,2}$/.test(value) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value);
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
      if (this.looksLikeDate(token)) {
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

  setNativeSelect(select, visibleLabel) {
    const wanted = String(visibleLabel).toLowerCase();
    const option = [...select.options].find((o) => o.textContent.trim().toLowerCase() === wanted)
      || [...select.options].find((o) => o.textContent.trim().toLowerCase().includes(wanted));
    if (!option) throw new Error(`Sort by has no option matching "${visibleLabel}"`);
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(select, option.value);
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return option.textContent.trim();
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
      applied = this.setNativeSelect(control, label);
    } else {
      this.fireClick(control);
      await this.sleep(250);
      const opts = [...document.querySelectorAll('[role="option"], option, li')];
      const wanted = label.toLowerCase();
      const opt =
        opts.find((el) => el.textContent.trim().toLowerCase() === wanted) ||
        opts.find((el) => el.textContent.trim().toLowerCase().includes(wanted));
      if (!opt) throw new Error(`Could not find sort option "${label}"`);
      this.fireClick(opt);
      applied = opt.textContent.trim();
    }
    await this.sleep(600);
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
    await this.sleep(100);
    const input = el.tagName === "INPUT" ? el : el.querySelector("input[type='checkbox'], input[type='radio']");
    const before = input ? input.checked : null;
    this.fireClick(clickable);
    if (input && !input.checked && clickable !== input) input.click();
    await this.sleep(800);
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
    this.fireClick(btn);
    for (let i = 0; i < 25; i += 1) {
      await this.sleep(400);
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
      await this.sleep(400);
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
      const target = hit[0].input.closest("label") || hit[0].input;
      this.fireClick(target);
      if (hit[0].input.checked !== want && typeof hit[0].input.click === "function") hit[0].input.click();
      await this.settle();
    }
    const key = (t) => t.replace(/\s*\(\d+\).*$/, "");
    const after = this.facetInputs().find((f) => f.group === hit[0].group && key(f.label) === key(hit[0].label));
    return { group: hit[0].group, label: hit[0].label, checked: after ? after.checked : null };
  }

  // Wait until the offer list stops changing (filters re-render the list async).
  async settle() {
    await this.sleep(800);
    let last = "";
    let stable = 0;
    for (let i = 0; i < 30 && stable < 3; i += 1) {
      const sig = this.offerButtons().map((el) => this.offerName(el)).join("|") + (this.hasStalePriceOverlay() ? "!" : "");
      stable = sig === last ? stable + 1 : 0;
      last = sig;
      await this.sleep(400);
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
      this.fireClick(btn);
      let grew = false;
      for (let i = 0; i < 15; i += 1) {
        await this.sleep(400);
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
    await this.sleep(150);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (el instanceof HTMLElement) el.focus({ preventScroll: true });
      this.fireClick(el);
      if (typeof el.click === "function") el.click();
      for (let n = 0; n < 10; n += 1) {
        await this.sleep(400);
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
    this.fireClick(hit.el);
    if (typeof hit.el.click === "function") hit.el.click();
    for (let n = 0; n < 25; n += 1) {
      await this.sleep(400);
      if (/returning flights/i.test(document.body?.innerText || "") || !this.fareButtons().length) break;
    }
    await this.sleep(600);
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
}
