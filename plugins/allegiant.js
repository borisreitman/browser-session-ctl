// Built-in plugin: search Allegiant flights on allegiantair.com and read results.
//
//   browser-session-ctl --tab <id> plugin.allegiant search BLI LAS 2026-10-16 2026-10-29
//   browser-session-ctl --tab <id> plugin.allegiant search BLI LAS 2026-10-16
//   browser-session-ctl --tab <id> plugin.allegiant search BLI LAS 2026-10-16 2026-10-29 2
//   browser-session-ctl --tab <id> plugin.allegiant results
//   browser-session-ctl --tab <id> plugin.allegiant day departing 2026-10-17
//   browser-session-ctl --tab <id> plugin.allegiant select departing 0
//   browser-session-ctl --tab <id> plugin.allegiant status
//
// Allegiant does not appear on Expedia/eDreams. Search has to go through
// allegiantair.com. There is no usable deep link: submit mints a booking
// session id in the path (/booking/<hex>/flights?o=…&d=…&ds=…). So `search`
// fills the homepage form (react-select airports + calendar) and presses
// Search. If the tab is not on the homepage it navigates there first; run
// search again after the page loads.
class Plugin {
  help() {
    return {
      namespace: "allegiant",
      methods: {
        help: "Show this message.",
        search:
          "search <from> <to> <depart> [return] [adults] — fill the allegiantair.com homepage form and press Search. Airport codes (BLI, LAS). Dates as YYYY-MM-DD or MM/DD/YYYY. Omit return (or pass oneway) for one-way. If the tab is not on the homepage it navigates there first; run search again. Allegiant does not fly every day; a date with no departure is not clickable.",
        destinations:
          "destinations <from> — pick the origin and list every airport Allegiant sells from it (the To menu only fills in after From is chosen).",
        results:
          "results — wait for the Select Flights list and return departing (and returning) flights: number, times, price, seats. Also the nearby-day tabs (price or No Flights).",
        day: "day <departing|returning> <YYYY-MM-DD> — click a date tab on the results page (use next/previous if it is off-screen). Then results.",
        select: "select <departing|returning> <index|flight> — click one flight row (0-based index from results, or a flight number like 272). Does not book.",
        close:
          "close — optional. search, results, day, select, and status already dismiss cookies and the credit-card ice-pop before they act.",
        status: "status — home, results, or other, plus origin/destination/dates when those are on the page.",
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

  clean(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  hook(name) {
    return document.querySelector(`[data-hook='${name}']`);
  }

  looksLikeDate(value) {
    return /^\d{4}-\d{1,2}-\d{1,2}$/.test(value) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value);
  }

  airport(value) {
    const code = String(value || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) {
      throw new Error(`"${value}" is not a 3-letter airport code (e.g. BLI, LAS, SFB).`);
    }
    return code;
  }

  toIsoDate(value) {
    const us = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
    const iso = String(value).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
    throw new Error(`Unrecognized date "${value}". Use YYYY-MM-DD or MM/DD/YYYY.`);
  }

  parseIso(value) {
    const iso = this.toIsoDate(value);
    const [y, m, d] = iso.split("-").map(Number);
    return { iso, y, m, d };
  }

  parseSearchArgs(from, to, depart, ...rest) {
    if (!from || !to || !depart) throw new Error("usage: search <from> <to> <depart> [return] [adults]");
    const params = {
      from: this.airport(from),
      to: this.airport(to),
      depart: this.toIsoDate(depart),
      returnDate: null,
      adults: 1,
    };
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

  hasForm() {
    return Boolean(this.hook("flight-search-form"));
  }

  isShown(el) {
    if (!el) return false;
    const rects = el.getClientRects();
    if (!rects.length) return false;
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
    const r = rects[0];
    return r.width > 0 && r.height > 0;
  }

  clickEl(el) {
    if (!el) return;
    this.fireClick(el);
    if (typeof el.click === "function") el.click();
  }

  cookieButton() {
    const understand = [...document.querySelectorAll("button, a, [role='button']")].find((b) =>
      /^\s*I understand\s*$/i.test(this.clean(b.textContent))
    );
    const accept = document.querySelector("#onetrust-accept-btn-handler");
    const el = understand || accept;
    return el && this.isShown(el) ? el : null;
  }

  // Credit-card ice-pop, generic Popup overlay, role=dialog — not the calendar,
  // travelers tray, cart, or OneTrust preference center.
  overlayRoots() {
    const nodes = [
      ...document.querySelectorAll(
        "[data-hook*='ice-pop'], [class*='OverlayMerchandise'], [class*='Popup__Overlay'], [class*='Popup__Dialog'], [role='dialog'], [role='alertdialog']"
      ),
    ];
    return nodes.filter((el) => {
      if (!this.isShown(el)) return false;
      const who = `${el.getAttribute("aria-label") || ""} ${el.id || ""} ${el.className || ""}`;
      if (/Privacy Preference Center|ot-sdk|onetrust-pc/i.test(who)) return false;
      if (/cart-popover/i.test(el.getAttribute("data-hook") || "") || /Cart__/i.test(String(el.className || ""))) {
        return false;
      }
      const r = el.getBoundingClientRect();
      return r.width >= 180 && r.height >= 120;
    });
  }

  overlayCloseButton() {
    const wrap =
      this.hook("overlay-merchandise_ice-pop") ||
      document.querySelector("[class*='OverlayMerchandise'][class*='OverlayWrapper'], [class*='OverlayMerchandise__OverlayWrapper']") ||
      this.promoRoot();
    const hooked = this.hook("overlay-merchandise_ice-pop_close");
    if (hooked && (this.isShown(hooked) || (wrap && this.isShown(wrap)))) return hooked;
    const roots = wrap && this.isShown(wrap) ? [wrap, ...this.overlayRoots()] : this.overlayRoots();
    const seen = new Set();
    for (const root of roots) {
      if (!root || seen.has(root)) continue;
      seen.add(root);
      const close = this.closeControlIn(root);
      if (close) return close;
    }
    return null;
  }

  promoRoot() {
    const applies = [...document.querySelectorAll("a, button, [role='button']")].filter((el) =>
      /^\s*apply now\s*$/i.test(this.clean(el.textContent)) && this.isShown(el)
    );
    for (const el of applies) {
      const root = el.closest("[data-hook*='ice-pop'], [class*='Overlay'], [class*='Popup'], [role='dialog']");
      if (root && this.isShown(root) && root.getBoundingClientRect().height >= 120) return root;
    }
    return null;
  }

  closeControlIn(root) {
    const candidates = [
      ...root.querySelectorAll(
        "[data-hook*='_close'], [data-hook*='-close'], button[aria-label='Close' i], [aria-label='Close' i], button[class*='Close'], button, [role='button']"
      ),
    ];
    return candidates.find((el) => {
      const t = this.clean(el.textContent);
      const aria = el.getAttribute("aria-label") || "";
      if (/apply now|allow all|search|continue|i understand/i.test(`${t} ${aria}`)) return false;
      if (/close/i.test(aria) || /close/i.test(el.getAttribute("data-hook") || "")) return this.isShown(el) || this.isShown(root);
      if (!t && el.querySelector("svg")) return this.isShown(el) || this.isShown(root);
      return false;
    });
  }

  hasOverlay() {
    return Boolean(this.overlayCloseButton() || this.overlayRoots().length || this.cookieButton() || this.promoRoot());
  }

  // Every command that touches the page goes through here so the user never
  // has to call close. Wait a bit: the credit-card ice-pop is often delayed.
  async ready() {
    const out = await this.close();
    if (!this.hasForm()) return out;
    const later = await this.close(2000);
    return {
      cookies: out.cookies || later.cookies,
      icepop: out.icepop || later.icepop,
      dismissed: [...out.dismissed, ...later.dismissed],
    };
  }

  async tap(el) {
    if (!el) return;
    if (this.hasOverlay()) await this.close();
    this.clickEl(el);
  }

  async close(waitMs) {
    const wait = Number(waitMs) || 0;
    const out = { cookies: false, icepop: false, dismissed: [] };
    const deadline = Date.now() + wait;
    for (;;) {
      const cookie = this.cookieButton();
      const overlay = this.overlayCloseButton();
      if (cookie) {
        this.clickEl(cookie);
        out.cookies = true;
        out.dismissed.push("cookies");
        await this.sleep(350);
        continue;
      }
      if (overlay) {
        this.clickEl(overlay);
        out.icepop = true;
        out.dismissed.push(overlay.getAttribute("data-hook") || overlay.getAttribute("aria-label") || "overlay");
        await this.sleep(350);
        continue;
      }
      if (Date.now() >= deadline) break;
      await this.sleep(300);
    }
    return out;
  }

  setInput(el, text) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    el.focus();
    set.call(el, "");
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: "", inputType: "deleteContentBackward" }));
    set.call(el, text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  airportOptions() {
    return [...document.querySelectorAll("[id^='react-select-'][id*='-option-'], [class*='-option']")].filter((el) =>
      /\([A-Z]{3}\)/.test(el.textContent || "")
    );
  }

  // The To menu does not open on a click of the wrapper; ArrowDown on the
  // (enabled) input does. It stays disabled until From is chosen, and it lists
  // only the airports Allegiant sells from that origin.
  openMenu(input) {
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, bubbles: true }));
  }

  menuOptions() {
    return this.airportOptions().filter((el) => /^react-select-(origin|destination)-option-/.test(el.id || ""));
  }

  menuLabels() {
    return [...new Set(this.menuOptions().map((el) => this.clean(el.textContent)))];
  }

  async pickAirport(which, code) {
    const hook = which === "to" ? "flight-search-destination" : "flight-search-origin";
    const inputId = which === "to" ? "select-destination" : "select-origin";
    const wrap = this.hook(hook);
    const input = document.getElementById(inputId);
    if (!wrap || !input) throw new Error(`No ${which} airport field on this page`);
    const already = this.hook(`${hook}_input`);
    if (already?.value === code) return already.value;
    if (input.disabled) throw new Error(`The ${which} airport field is disabled. Pick From first.`);
    await this.tap(wrap);
    await this.sleep(200);
    input.focus();
    this.setInput(input, code);
    const want = `(${code})`;
    let opt = null;
    for (let i = 0; i < 15 && !opt; i += 1) {
      await this.sleep(200);
      opt = this.menuOptions().find((el) => (el.textContent || "").includes(want));
    }
    if (!opt) {
      // Open the full menu (ArrowDown) and scan it: typing a code does not
      // always filter the way the label reads.
      this.setInput(input, "");
      this.openMenu(input);
      for (let i = 0; i < 15 && !opt; i += 1) {
        await this.sleep(250);
        opt = this.menuOptions().find((el) => (el.textContent || "").includes(want));
      }
    }
    if (!opt) {
      const offered = this.menuLabels();
      throw new Error(
        which === "to"
          ? `Allegiant does not sell ${code} from the chosen origin. Airports offered: ${offered.join("; ") || "none listed"}.`
          : `Allegiant has no airport ${code} in the From list.`
      );
    }
    await this.tap(opt);
    await this.sleep(400);
    const hidden = this.hook(`${hook}_input`);
    if (hidden && hidden.value !== code) {
      throw new Error(`Picking ${code} as ${which} did not stick (hidden field is "${hidden.value || ""}")`);
    }
    return this.clean(opt.textContent);
  }

  // destinations <from> — pick the origin, open the To menu, and return every
  // airport Allegiant offers from there (the list only fills after From is set).
  async destinations(from) {
    if (!this.hasForm()) {
      setTimeout(() => location.assign("https://www.allegiantair.com/"), 50);
      return { navigating: true, next: "wait for the homepage to load, then run destinations again" };
    }
    await this.ready();
    const code = this.airport(from);
    await this.pickAirport("from", code);
    const input = document.getElementById("select-destination");
    if (!input) throw new Error("No destination airport field on this page");
    if (input.disabled) throw new Error("The destination field is still disabled after picking From.");
    this.setInput(input, "");
    this.openMenu(input);
    let labels = [];
    for (let i = 0; i < 20 && !labels.length; i += 1) {
      await this.sleep(250);
      labels = this.menuLabels();
    }
    return { from: code, count: labels.length, destinations: labels };
  }

  async setTripType(roundtrip) {
    const want = roundtrip ? "ROUNDTRIP" : "ONEWAY";
    const current = document.querySelector("input[name='trip_type']:checked")?.value;
    if (current === want) return;
    const label = this.hook(`flight-search-trip-type_${want}`);
    if (!label) throw new Error("No Round Trip / One way control");
    await this.tap(label);
    await this.sleep(250);
  }

  ordinal(n) {
    const v = n % 100;
    if (v >= 11 && v <= 13) return `${n}th`;
    return `${n}${["th", "st", "nd", "rd"][n % 10] || "th"}`;
  }

  async openCalendar(which = "start") {
    const hook =
      which === "end"
        ? "flight-search-date-picker_expand-end-date"
        : "flight-search-date-picker_expand-start-date";
    const btn = this.hook(hook);
    if (!btn) throw new Error(which === "end" ? "No return calendar button" : "No departure calendar button");
    if (btn.disabled) throw new Error("Calendar is disabled — pick origin and destination first.");
    if (btn.getAttribute("aria-expanded") !== "true") {
      await this.tap(btn);
      await this.sleep(400);
    }
  }

  dayButtons() {
    return [...document.querySelectorAll("button[data-hook*='select-day']")];
  }

  dayDisabled(btn) {
    return Boolean(btn.disabled) || btn.getAttribute("aria-disabled") === "true";
  }

  async pickDay(iso, which = "start") {
    const { y, m, d } = this.parseIso(iso);
    const target = new Date(y, m - 1, d);
    const month = target.toLocaleString("en-US", { month: "long" });
    const weekday = target.toLocaleString("en-US", { weekday: "long" });
    const ariaRe = new RegExp(
      `${weekday},\\s+${month}\\s+${this.ordinal(d)}\\s+${y}`,
      "i"
    );
    await this.openCalendar(which);
    for (let i = 0; i < 16; i += 1) {
      const btn = this.dayButtons().find((el) => ariaRe.test(el.getAttribute("aria-label") || ""));
      if (btn) {
        if (this.dayDisabled(btn)) {
          throw new Error(
            `${iso} is not bookable on this Allegiant route (no departure that day, or past / beyond the booking window).`
          );
        }
        await this.tap(btn);
        await this.sleep(400);
        return { iso, which, label: btn.getAttribute("aria-label") };
      }
      const next = this.hook("flight-search-date-picker_navigate-next-month");
      if (!next || next.disabled) break;
      await this.tap(next);
      await this.sleep(300);
    }
    throw new Error(`Could not find ${iso} in the Allegiant calendar`);
  }

  async setAdults(n) {
    if (n === 1) return;
    const open = this.hook("flight-search-travelers-expando-button");
    if (!open) throw new Error("No Travelers control");
    await this.tap(open);
    await this.sleep(300);
    const seated = () => Number(this.hook("flight-search-travelers-seated")?.textContent || 1);
    for (let i = 0; i < 12 && seated() !== n; i += 1) {
      const buttons = [...document.querySelectorAll("button")];
      const plus = buttons.find((b) => /add|increase|\+/i.test(b.getAttribute("aria-label") || b.textContent || ""));
      const minus = buttons.find((b) => /subtract|decrease|minus/i.test(b.getAttribute("aria-label") || b.textContent || ""));
      const btn = seated() < n ? plus : minus;
      if (!btn || btn.disabled) break;
      await this.tap(btn);
      await this.sleep(150);
    }
    if (seated() !== n) throw new Error(`Could not set seated travelers to ${n}`);
  }

  async search(from, to, depart, ...rest) {
    const p = this.parseSearchArgs(from, to, depart, ...rest);
    if (!this.hasForm()) {
      setTimeout(() => location.assign("https://www.allegiantair.com/"), 50);
      return { navigating: true, next: "wait for the homepage to load, then run search again" };
    }
    await this.ready();
    await this.setTripType(Boolean(p.returnDate));
    const originLabel = await this.pickAirport("from", p.from);
    const destLabel = await this.pickAirport("to", p.to);
    await this.pickDay(p.depart, "start");
    if (p.returnDate) await this.pickDay(p.returnDate, "end");
    await this.setAdults(p.adults);
    const submit = this.hook("flight-search-submit");
    if (!submit) throw new Error("No Search button");
    if (submit.disabled) throw new Error("Search is still disabled — airports or dates did not stick.");
    if (this.hasOverlay()) await this.close();
    setTimeout(() => {
      this.clickEl(submit);
    }, 50);
    return {
      from: p.from,
      to: p.to,
      depart: p.depart,
      return: p.returnDate,
      adults: p.adults,
      originLabel,
      destLabel,
      next: "wait a few seconds for /booking/…/flights, then run results",
    };
  }

  pageKind() {
    if (/\/booking\/[^/]+\/flights/i.test(location.href) || this.hook("flights-page_page-heading")) return "results";
    if (this.hasForm()) return "home";
    if (/allegiantair\.com/i.test(location.hostname)) return "other";
    return "other";
  }

  hour24(t) {
    const m = String(t || "").match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
    if (!m) return null;
    let h = Number(m[1]) % 12;
    if (/pm/i.test(m[3])) h += 12;
    return h + Number(m[2]) / 60;
  }

  period(t) {
    const h = this.hour24(t);
    if (h == null) return null;
    if (h < 5) return "early-morning";
    if (h < 12) return "morning";
    if (h < 18) return "afternoon";
    return "evening";
  }

  textHook(root, name) {
    return this.clean((root || document).querySelector(`[data-hook='${name}']`)?.textContent);
  }

  parseFlight(el, index, leg) {
    const hook = el.getAttribute("data-hook") || "";
    const number = hook.match(/_(\d+)$/)?.[1] || this.textHook(el, "flight-number") || null;
    const depart = this.textHook(el, "flight-departure-time") || null;
    const arrive = this.textHook(el, "flight-arrival-time") || null;
    const price = this.textHook(el, "flight-price") || null;
    const original = this.textHook(el, "strikethrough-flight-price") || null;
    const seats = this.textHook(el, "seats-availability-text") || null;
    const label = this.clean(el.innerText).slice(0, 200);
    return {
      leg,
      index,
      flight: number,
      depart,
      arrive,
      period: this.period(depart),
      price,
      original,
      seats,
      selected: /^selected-flight_/.test(hook),
      label,
    };
  }

  flightCards(leg) {
    return [
      ...document.querySelectorAll(`[data-hook^='unselected-flight_${leg}_'], [data-hook^='selected-flight_${leg}_']`),
    ];
  }

  parseDays(leg) {
    return [...document.querySelectorAll(`[data-hook^='day-tab_${leg}_']`)].map((el) => {
      const date = (el.getAttribute("data-hook") || "").match(/(\d{4}-\d{2}-\d{2})$/)?.[1] || null;
      const text = this.clean(el.textContent);
      const no = /no flights/i.test(text);
      const price = text.match(/\$[\d,.]+/)?.[0] || null;
      const selected = el.getAttribute("aria-selected") === "true" || /TabButton.*bpTlDK/.test(el.className);
      return { date, price, noFlights: no, selected: el.getAttribute("aria-selected") === "true" || null, label: text };
    });
  }

  parseOffers() {
    const departing = this.flightCards("departing").map((el, i) => this.parseFlight(el, i, "departing"));
    const returning = this.flightCards("returning").map((el, i) => this.parseFlight(el, i, "returning"));
    return { departing, returning };
  }

  headerInfo() {
    const dateHook = (prefix) => {
      const el = [...document.querySelectorAll(`[data-hook^='${prefix}']`)].find((e) =>
        /\d{4}-\d{2}-\d{2}/.test(e.getAttribute("data-hook") || "")
      );
      return (el?.getAttribute("data-hook") || "").match(/(\d{4}-\d{2}-\d{2})$/)?.[1] || null;
    };
    return {
      from: this.textHook(document, "header-flight-info_origin") || this.textHook(document, "departing-flight-details_origin-airport") || null,
      to: this.textHook(document, "header-flight-info_destination") || this.textHook(document, "departing-flight-details_destination-airport") || null,
      trip: this.textHook(document, "header-flight-info_trip-type") || null,
      depart: dateHook("header-flight-info_departing-date_"),
      return: dateHook("header-flight-info_return-date_"),
    };
  }

  async waitForResults(tries = 40) {
    for (let i = 0; i < tries; i += 1) {
      if (this.hasOverlay()) await this.close();
      if (this.flightCards("departing").length || this.hook("flights-list_departing")) return true;
      const body = document.body?.innerText || "";
      if (/no flights/i.test(body) && this.hook("days-tabs_departing")) return true;
      await this.sleep(400);
    }
    return false;
  }

  async results() {
    await this.ready();
    if (this.pageKind() !== "results") {
      throw new Error(
        `This tab is not showing Allegiant flight results (${this.pageKind()}: ${location.href}). Run plugin.allegiant search first.`
      );
    }
    if (!(await this.waitForResults())) {
      throw new Error("Timed out waiting for Allegiant flights to render. Retry results.");
    }
    await this.sleep(400);
    const { departing, returning } = this.parseOffers();
    return {
      url: location.href,
      title: document.title,
      ...this.headerInfo(),
      count: departing.length + returning.length,
      days: { departing: this.parseDays("departing"), returning: this.parseDays("returning") },
      flights: { departing, returning },
    };
  }

  async day(leg, date) {
    await this.ready();
    const which = String(leg || "").toLowerCase();
    if (!["departing", "returning", "outbound", "return"].includes(which)) {
      throw new Error("usage: day <departing|returning> <YYYY-MM-DD>");
    }
    const side = which === "outbound" || which === "departing" ? "departing" : "returning";
    const iso = this.toIsoDate(date);
    for (let i = 0; i < 10; i += 1) {
      const tab = this.hook(`day-tab_${side}_${iso}`);
      if (tab) {
        if (/no flights/i.test(tab.textContent || "")) {
          return { date: iso, leg: side, noFlights: true, clicked: false };
        }
        await this.tap(tab);
        await this.sleep(800);
        return { date: iso, leg: side, clicked: true, count: this.flightCards(side).length };
      }
      const next = this.hook(`next-arrow_${side}`);
      if (!next || next.disabled) break;
      await this.tap(next);
      await this.sleep(400);
    }
    throw new Error(`No ${side} day tab for ${iso}. Use results to see which days Allegiant is showing.`);
  }

  async select(leg, which) {
    await this.ready();
    const want = String(leg || "").toLowerCase();
    const side = want === "outbound" || want === "departing" ? "departing" : want === "return" || want === "returning" ? "returning" : null;
    if (!side || which === undefined) throw new Error("usage: select <departing|returning> <index|flight>");
    const cards = this.flightCards(side);
    if (!cards.length) throw new Error(`No ${side} flights on this page. Run results first.`);
    let el;
    const asInt = Number(which);
    if (String(which).trim() !== "" && Number.isInteger(asInt) && asInt >= 0 && String(asInt) === String(which).trim()) {
      el = cards[asInt];
      if (!el) throw new Error(`No ${side} flight at index ${asInt} (have ${cards.length})`);
    } else {
      const num = String(which).replace(/^g4/i, "").trim();
      el = cards.find((c) => (c.getAttribute("data-hook") || "").endsWith(`_${num}`));
      if (!el) throw new Error(`No ${side} flight ${which}. Run results.`);
    }
    el.scrollIntoView({ block: "center" });
    await this.sleep(150);
    const clickable = el.querySelector("[data-hook='flight-price-box']") || el;
    await this.tap(clickable);
    await this.sleep(800);
    return {
      selected: this.parseFlight(el, cards.indexOf(el), side),
      url: location.href,
    };
  }

  async status() {
    const { cookies, icepop, dismissed } = await this.ready();
    const kind = this.pageKind();
    const flights = kind === "results" ? this.parseOffers() : { departing: [], returning: [] };
    return {
      url: location.href,
      title: document.title,
      kind,
      cookies,
      icepop,
      dismissed,
      ...(kind === "home"
        ? {
            origin: this.hook("flight-search-origin_input")?.value || null,
            destination: this.hook("flight-search-destination_input")?.value || null,
            depart: document.getElementById("departure_date")?.value || null,
            return: document.getElementById("return_date")?.value || null,
            trip: document.querySelector("input[name='trip_type']:checked")?.value || null,
          }
        : {}),
      ...(kind === "results" ? { ...this.headerInfo(), departing: flights.departing.length, returning: flights.returning.length } : {}),
    };
  }
}
