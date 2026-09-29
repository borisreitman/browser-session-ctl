// Built-in plugin: search easyJet flights on easyjet.com and read the results.
//
//   browser-session-ctl --tab <id> plugin.easyjet search LGW BCN 2026-10-12 2026-10-19
//   browser-session-ctl --tab <id> plugin.easyjet search LGW BCN 2026-10-12
//   browser-session-ctl --tab <id> plugin.easyjet search LGW BCN 2026-10-12 2026-10-19 2
//   browser-session-ctl --tab <id> plugin.easyjet results
//   browser-session-ctl --tab <id> plugin.easyjet status
//
// easyjet.com has no usable deep link: /en/buy/flights?origin=… just bounces
// to the homepage. So `search` fills the homepage search pod the way a person
// would (airport picker, date picker, passengers) and presses "Show flights".
// `search` must run on an easyjet.com/en homepage tab; anywhere else it
// navigates there and asks you to run it again.
class Plugin {
  help() {
    return {
      namespace: "easyjet",
      methods: {
        help: "Show this message.",
        search:
          "search <from> <to> <depart> [return] [adults] — fill the easyjet.com homepage form and press Show flights. Airport codes (LGW, BCN). Dates as YYYY-MM-DD or MM/DD/YYYY. Omit return (or pass oneway) for one-way. If the tab is not on the homepage it navigates there first; run search again. Partner routes (e.g. LGW TLV) land on flightconnections.easyjet.com — see the header comment.",
        results: "results — wait for the flight tiles and return them per leg (outbound/return): date, departure/arrival, price, seats left. Only the days easyJet shows around your date.",
        select: "select <outbound|return> <index> — click one tile from results. Does not book.",
        status: "status — what this tab is showing (home, results, other) and the search pod values.",
      },
    };
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // easyJet's React widgets ignore a bare .click(); send the whole sequence.
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

  clean(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  toIsoDate(value) {
    const us = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (us) return { y: Number(us[3]), m: Number(us[1]), d: Number(us[2]) };
    const iso = String(value).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
    throw new Error(`Unrecognized date "${value}". Use YYYY-MM-DD or MM/DD/YYYY.`);
  }

  looksLikeDate(value) {
    return /^\d{4}-\d{1,2}-\d{1,2}$/.test(value) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value);
  }

  airport(value) {
    const code = String(value || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) {
      throw new Error(`"${value}" is not a 3-letter airport code (e.g. LGW, BCN, JFK).`);
    }
    return code;
  }

  parseSearchArgs(from, to, depart, ...rest) {
    if (!from || !to || !depart) throw new Error("usage: search <from> <to> <depart> [return] [adults]");
    const params = { from: this.airport(from), to: this.airport(to), depart: this.toIsoDate(depart), returnDate: null, adults: 1 };
    for (const token of rest) {
      if (token == null || token === "") continue;
      const lower = String(token).toLowerCase();
      if (this.looksLikeDate(token)) params.returnDate = this.toIsoDate(token);
      else if (lower === "oneway" || lower === "one-way") params.returnDate = null;
      else if (/^\d+$/.test(token)) {
        params.adults = Number(token);
        if (params.adults < 1 || params.adults > 9) throw new Error("adults must be between 1 and 9");
      } else throw new Error(`Unrecognized argument "${token}".`);
    }
    return params;
  }

  fmt(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.y}-${p(d.m)}-${p(d.d)}`;
  }

  hasForm() {
    return Boolean(document.querySelector("[data-testid='searchpod'] #from"));
  }

  setInput(el, text) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async waitFor(fn, tries = 20, ms = 250) {
    for (let i = 0; i < tries; i += 1) {
      const v = fn();
      if (v) return v;
      await this.sleep(ms);
    }
    return null;
  }

  async pickAirport(field, code) {
    const input = document.getElementById(field);
    if (!input) throw new Error(`No "${field}" field on this page`);
    input.focus();
    this.fireClick(input);
    this.setInput(input, "");
    await this.sleep(100);
    this.setInput(input, code);
    const item = await this.waitFor(() => document.querySelector(`[data-testid='${code}-airport-item']`), 20, 250);
    if (!item) throw new Error(`easyJet has no airport ${code} in the "${field}" list`);
    this.fireClick(item.querySelector("label") || item);
    await this.sleep(500);
    if (!input.value.includes(`(${code})`)) throw new Error(`Picking ${code} in "${field}" did not stick (field says "${input.value}")`);
  }

  async openDates() {
    if (!document.querySelector("[data-testid='datepicker-container']")) {
      this.fireClick(document.getElementById("when"));
      if (!(await this.waitFor(() => document.querySelector("[data-testid='datepicker-container']")))) {
        throw new Error("Date picker did not open");
      }
    }
  }

  async pickDay(d) {
    const id = `${d.d}-${d.m}-${d.y}`;
    for (let i = 0; i < 14; i += 1) {
      const btn = document.querySelector(`[data-testid='${id}']`);
      if (btn) {
        if (btn.disabled) throw new Error(`${this.fmt(d)} is not bookable (past, or beyond easyJet's booking window)`);
        this.fireClick(btn);
        await this.sleep(400);
        return;
      }
      const next = document.querySelector("[data-testid='next-nav-button']");
      if (!next || next.disabled) break;
      this.fireClick(next);
      await this.sleep(250);
    }
    throw new Error(`Could not find ${this.fmt(d)} in the calendar`);
  }

  async setTripType(returning) {
    const toggle = document.querySelector("[data-testid='toggle']");
    if (!toggle) return;
    const isReturn = toggle.getAttribute("aria-checked") === "true";
    if (isReturn !== returning) {
      this.fireClick(toggle);
      await this.sleep(300);
    }
  }

  async setAdults(n) {
    const who = document.getElementById("who");
    this.fireClick(who);
    const section = await this.waitFor(() => document.querySelector("[data-testid='adult-section']"));
    if (!section) throw new Error("Passenger picker did not open");
    const qty = () => Number(section.querySelector("[data-testid='quantity']").value);
    for (let i = 0; i < 12 && qty() !== n; i += 1) {
      const btn = section.querySelector(qty() < n ? "[data-testid='add-button']" : "[data-testid='subtract-button']");
      if (btn.disabled) break;
      this.fireClick(btn);
      await this.sleep(150);
    }
    if (qty() !== n) throw new Error(`Could not set adults to ${n} (easyJet allows up to 9 seats)`);
  }

  async search(from, to, depart, ...rest) {
    const p = this.parseSearchArgs(from, to, depart, ...rest);
    if (!this.hasForm()) {
      setTimeout(() => location.assign("https://www.easyjet.com/en"), 50);
      return { navigating: true, next: "wait for the homepage to load, then run search again" };
    }
    await this.pickAirport("from", p.from);
    await this.pickAirport("to", p.to);
    await this.openDates();
    await this.setTripType(Boolean(p.returnDate));
    await this.pickDay(p.depart);
    if (p.returnDate) await this.pickDay(p.returnDate);
    await this.setAdults(p.adults);
    const submit = document.querySelector("[data-testid='submit']");
    if (!submit) throw new Error("No Show flights button");
    // Routes easyJet does not fly itself (e.g. LGW-TLV) open "Connections by
    // easyJet" (flightconnections.easyjet.com) in a popup, which a scripted
    // click can't open. Catch the window.open and load that URL in this tab.
    const opened = [];
    const realOpen = window.open;
    window.open = (url) => {
      opened.push(String(url));
      return null;
    };
    const result = {
      from: p.from,
      to: p.to,
      depart: this.fmt(p.depart),
      return: p.returnDate ? this.fmt(p.returnDate) : null,
      adults: p.adults,
      pod: this.pod(),
    };
    try {
      this.fireClick(submit);
      await this.sleep(1500);
    } finally {
      window.open = realOpen;
    }
    if (opened.length) {
      setTimeout(() => location.assign(opened[0]), 50);
      return {
        ...result,
        via: /^(https?:)?\/\/[^/]*flightconnections/i.test(opened[0]) ? "connections" : "easyjet",
        url: opened[0],
        next: /flightconnections/i.test(opened[0]) ? "partner-operated route: wait for flightconnections.easyjet.com, click `Reject all` on its cookie modal, then read with the built-in `text` command (plugins cannot run there: its CSP forbids eval)" : "wait a few seconds, then run results",
      };
    }
    return { ...result, via: "easyjet", next: "wait a few seconds, then run results" };
  }

  pod() {
    const val = (id) => document.getElementById(id)?.value || null;
    return { from: val("from"), to: val("to"), when: val("when"), who: val("who") };
  }

  pageKind() {
    if (this.hasForm()) return "home";
    if (/easyjet\.com\/.*\/buy\/flights/i.test(location.href)) return "results";
    return "other";
  }

  status() {
    return { url: location.href, title: document.title, kind: this.pageKind(), ...(this.hasForm() ? { pod: this.pod() } : {}) };
  }

  tiles() {
    return [...document.querySelectorAll("[class*='FlightTile_flightTile__']")];
  }

  sections() {
    return [...document.querySelectorAll("section[class*='FlightGridLayout_flightGridSectionContainer']")];
  }

  parseTile(tile, leg, index) {
    const label = this.clean(tile.querySelector("[class*='FlightTile_a11yLabel']")?.textContent || tile.textContent);
    const id = tile.querySelector("[class*='FlightTile_a11yLabel']")?.id || "";
    const m = label.match(/for (.*?)\. Departure (.*?), Arrival (.*?), Price (\S+?)(?: (.*))?$/i);
    const route = id.match(/^standard-([A-Z]{3})_([A-Z]{3})_/);
    return {
      leg,
      index,
      date: m?.[1] || null,
      depart: m?.[2] || null,
      arrive: m?.[3] || null,
      price: m?.[4] || null,
      note: m?.[5] || null,
      route: route ? `${route[1]}-${route[2]}` : null,
      soldOut: /sold out|no flights/i.test(label),
      label,
    };
  }

  async results() {
    if (this.pageKind() !== "results") {
      throw new Error(`This tab is not showing easyJet results (${this.pageKind()}: ${location.href}). Run search first.`);
    }
    if (!(await this.waitFor(() => this.tiles().length, 60, 500))) {
      if (/no flights available/i.test(document.body.innerText)) return { url: location.href, count: 0, flights: [] };
      throw new Error("Timed out waiting for flight tiles. Retry results.");
    }
    await this.sleep(500);
    const sections = this.sections();
    const flights = [];
    (sections.length ? sections : [document]).forEach((sec, si) => {
      const leg = si === 0 ? "outbound" : "return";
      [...sec.querySelectorAll("[class*='FlightTile_flightTile__']")].forEach((t, i) => flights.push(this.parseTile(t, leg, i)));
    });
    return { url: location.href, title: document.title, count: flights.length, flights };
  }

  async select(leg, index) {
    const want = String(leg || "").toLowerCase();
    if (!["outbound", "return"].includes(want)) throw new Error("usage: select <outbound|return> <index> (index from results)");
    const all = (await this.results()).flights.filter((f) => f.leg === want);
    const f = all[Number(index)];
    if (!f) throw new Error(`No ${want} flight at index ${index} (have ${all.length})`);
    const sec = this.sections()[want === "outbound" ? 0 : 1] || document;
    const tile = [...sec.querySelectorAll("[class*='FlightTile_flightTile__']")][Number(index)];
    tile.scrollIntoView({ block: "center" });
    await this.sleep(150);
    this.fireClick(tile.querySelector("button, [role='button']") || tile);
    await this.sleep(1500);
    return { selected: f, url: location.href };
  }
}
