// Built-in plugin: search Expedia flights and read the results list.
//
//   browser-session-ctl --tab <id> plugin.expedia search SEA SFO 2026-10-12 2026-10-19
//   browser-session-ctl --tab <id> plugin.expedia search SEA SFO 2026-10-12
//   browser-session-ctl --tab <id> plugin.expedia search SEA SFO 2026-10-12 2026-10-19 business 2
//   browser-session-ctl --tab <id> plugin.expedia sort cheapest
//   browser-session-ctl --tab <id> plugin.expedia leave evening
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
          "search <from> <to> <depart> [return] [cabin] [adults] — open Expedia flight results. Airport codes (SEA, SFO). Dates as YYYY-MM-DD or MM/DD/YYYY. Omit return (or pass oneway) for one-way. cabin: economy | premium | business | first. Then call results.",
        sort:
          "sort [cheapest|recommended|duration|latest|earliest] — set the results Sort by control. Default: cheapest (Price: low to high).",
        leave:
          "leave <early-morning|morning|afternoon|evening> — toggle the left-rail Departure time filter (origin local time). evening is 6:00pm–11:59pm. Repeat to uncheck.",
        results:
          "results — wait for the current tab's flight list and return structured offers (airline, times, price, stops).",
        select: "select <index> — click one offer from the last results() list (0-based).",
        status: "status — what this tab is showing: home, results, or other, plus the form values.",
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
      /^Select(?: and show fare information for)?\s+(.+?)\s+flight,\s+departing at\s+(\d{1,2}:\d{2}\s*(?:am|pm))(?:\s+from\s+[^,]+)?,?\s+arriving at\s+(\d{1,2}:\d{2}\s*(?:am|pm))(?:\s+in\s+[^,]+)?,?\s+[Pp]riced at\s+(\$[\d,]+)(?:\s+(\w+))?/i
    );
    const stops = name.match(/\b(Nonstop|One stop|\d+\s*stops?)\b/i)?.[1] || null;
    const layover = name.match(/Layover for ([^.]+)\./i)?.[1]?.trim() || null;
    const card = el.closest(
      "[data-test-id='offer-listing'], [data-test-id='flight-card'], li, [class*='uitk-card']"
    );
    const cardText = (card?.innerText || el.innerText || "").replace(/\s+/g, " ").trim();
    const duration = cardText.match(/(\d+h(?:\s*\d+m)?)\s*•/i)?.[1] || null;
    const route = cardText.match(/([A-Za-z .]+ \(\w{3}\))\s*-\s*([A-Za-z .]+ \(\w{3}\))/) || null;
    const depart = parsed?.[2] || null;
    return {
      index,
      airline: parsed?.[1]?.replace(/^multiple/i, "Multiple ") || null,
      depart,
      arrive: parsed?.[3] || null,
      price: parsed?.[4] || null,
      trip: parsed?.[5] || null,
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

  async sort(how = "cheapest") {
    const aliases = {
      cheapest: "Price: low to high",
      price: "Price: low to high",
      cheap: "Price: low to high",
      "low-to-high": "Price: low to high",
      recommended: "Recommended",
      duration: "Shortest duration",
      shortest: "Shortest duration",
      latest: "Latest departure",
      earliest: "Earliest departure",
    };
    const key = String(how || "cheapest").toLowerCase();
    const label = aliases[key] || how;
    const control = this.sortControl();
    if (!control) throw new Error('No "Sort by" control on this page');
    control.scrollIntoView({ block: "center", inline: "nearest" });
    let applied;
    if (control.tagName === "SELECT") {
      applied = this.setNativeSelect(control, label);
    } else {
      this.fireClick(control);
      await this.sleep(250);
      const opt = [...document.querySelectorAll('[role="option"], option, li')].find((el) =>
        el.textContent.trim().toLowerCase().includes(label.toLowerCase())
      );
      if (!opt) throw new Error(`Could not find sort option "${label}"`);
      this.fireClick(opt);
      applied = opt.textContent.trim();
    }
    await this.sleep(600);
    return { sort: applied, count: this.parseOffers().length };
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

  async results() {
    for (let i = 0; i < 12; i += 1) {
      const flights = this.parseOffers();
      if (flights.length) {
        return {
          url: location.href,
          title: document.title,
          count: flights.length,
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

  async select(index) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0) throw new Error(`select <index> needs a 0-based index, got "${index}"`);
    const flights = this.parseOffers();
    if (!flights.length) {
      throw new Error("No flight offers on this page. Run plugin.expedia results first.");
    }
    const buttons = this.offerButtons();
    const el = buttons[i];
    if (!el) throw new Error(`No offer at index ${i} (page has ${buttons.length})`);
    this.fireClick(el);
    await this.sleep(300);
    return { selected: flights[i], url: location.href };
  }

  status() {
    const flights = this.parseOffers();
    return {
      url: location.href,
      title: document.title,
      kind: this.pageKind(),
      from: this.fieldValue(/leaving from/i),
      to: this.fieldValue(/going to/i),
      dates: this.buttonName(/^Dates\b/i),
      travelers: this.buttonName(/^Travelers/i),
      resultCount: flights.length,
    };
  }
}
