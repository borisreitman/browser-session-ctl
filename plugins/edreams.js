// Built-in plugin: search eDreams flights and read the results list.
//
//   browser-session-ctl --tab <id> plugin.edreams search LGW BCN 2026-10-12 2026-10-19
//   browser-session-ctl --tab <id> plugin.edreams search LGW BCN 2026-10-12
//   browser-session-ctl --tab <id> plugin.edreams search LGW BCN 2026-10-12 2026-10-19 2
//   browser-session-ctl --tab <id> plugin.edreams sort cheapest
//   browser-session-ctl --tab <id> plugin.edreams airlines
//   browser-session-ctl --tab <id> plugin.edreams airline easyjet
//   browser-session-ctl --tab <id> plugin.edreams direct
//   browser-session-ctl --tab <id> plugin.edreams results
//   browser-session-ctl --tab <id> plugin.edreams select 0
//   browser-session-ctl --tab <id> plugin.edreams status
//
// eDreams is a metasearch that also sells easyJet (U2 / EC), Ryanair, Wizz,
// Vueling etc., so this is the way to look at easyJet fares without driving
// easyjet.com (whose booking flow is a bot-guarded SPA with no usable
// deep link). Like the expedia plugin, `search` loads the results URL the
// site itself uses instead of filling its typeahead form; `results` and
// `select` then read the rendered itinerary cards.
class Plugin {
  help() {
    return {
      namespace: "edreams",
      methods: {
        help: "Show this message.",
        search:
          "search <from> <to> <depart> [return] [adults] — open eDreams flight results. Airport codes (LGW, BCN). Dates as YYYY-MM-DD or MM/DD/YYYY. Omit return (or pass oneway) for one-way. Then run sort cheapest and results.",
        sort: "sort [cheapest|best|fastest] — click a sort tab. Default: cheapest.",
        airlines: "airlines — list the airline filter checkboxes on this results page (code, name, checked).",
        airline:
          "airline <code|name> — toggle one airline in the left-rail filter, e.g. `airline U2` or `airline easyjet` (matches easyJet and EasyJet Europe). Repeat to undo. Use `airline only <code|name>` to keep just that airline.",
        direct: "direct — toggle the 'Direct flights' checkbox.",
        results: "results — wait for the itinerary cards, return them in the page's current sort order. Does not change sort.",
        select: "select <index> — click the price button of one itinerary (0-based). Does not change sort.",
        close: "close — dismiss the cookie-consent modal (Continue without agreeing) and the Prime 'I understand' overlay. No-op if neither is showing. Every other method that touches the page does this first.",
        status: "status — what this tab is showing (home, results, other), sort, and result count.",
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

  // eDreams wants YYYY-MM-DD in the URL.
  toIsoDate(value) {
    const us = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
    const iso = String(value).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
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
    params.type = params.returnDate ? "R" : "O";
    return params;
  }

  searchUrl(p) {
    const parts = [
      `type=${p.type}`,
      `dep=${p.depart}`,
      `from=${p.from}`,
      `to=${p.to}`,
    ];
    if (p.returnDate) parts.push(`ret=${p.returnDate}`);
    parts.push(`adults=${p.adults}`, "children=0", "infants=0", "internalSearch=true");
    return `https://www.edreams.com/travel/#results/${parts.join(";")}`;
  }

  search(from, to, depart, ...rest) {
    const params = this.parseSearchArgs(from, to, depart, ...rest);
    const url = this.searchUrl(params);
    // Navigate after this call returns so executeScript can reply first.
    // A hash-only change doesn't reload the SPA's results, so force one.
    const sameDoc = /edreams\.[a-z.]+\/travel\/?(\?[^#]*)?#/i.test(location.href);
    setTimeout(() => {
      location.assign(url);
      if (sameDoc) setTimeout(() => location.reload(), 100);
    }, 50);
    return { ...params, url };
  }

  // Overlays that sit on top of the results list. Never click "Agree".
  overlayButton() {
    const re = /^(continue without agreeing|i understand)$/i;
    const nodes = document.querySelectorAll("a, button, [role='button']");
    for (const el of nodes) {
      if (re.test(this.clean(el.textContent))) return el;
    }
    return null;
  }

  consentButton() {
    return this.overlayButton();
  }

  hasConsentModal() {
    return Boolean(this.overlayButton());
  }

  async dismissConsent() {
    const btn = this.overlayButton();
    if (!btn) return { consent: false };
    this.fireClick(btn);
    if (typeof btn.click === "function") btn.click();
    for (let i = 0; i < 10; i += 1) {
      await this.sleep(200);
      if (!this.hasConsentModal()) return { consent: true };
    }
    // Prime "I understand" sometimes stays in the DOM but is inert; keep going.
    return { consent: true, overlayStuck: true };
  }

  async close() {
    return this.dismissConsent();
  }

  itineraries() {
    const byTestId = [...document.querySelectorAll("[data-testid='itinerary']")];
    const seen = new Set(byTestId);
    const extra = [];
    // Newer results UI virtualizes into [data-testid='itinerary-list'].
    // Painted rows often nest the itinerary test id inside a wrapper that
    // itself has none; unpainted wrappers have no DEPARTURE text yet.
    const list = document.querySelector("[data-testid='itinerary-list']");
    if (list) {
      for (const el of list.querySelectorAll("[data-testid='itinerary']")) {
        if (!seen.has(el)) {
          seen.add(el);
          extra.push(el);
        }
      }
      for (const el of list.children) {
        if (seen.has(el) || el.querySelector("[data-testid='itinerary']")) continue;
        if (/DEPARTURE|RETURN/.test(el.innerText || "")) extra.push(el);
      }
    }
    return byTestId.concat(extra);
  }

  isDisplayed(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden" && Number(st.opacity) !== 0;
  }

  // True while the waiting page / spinner is actually on screen. The waiting
  // widget stays in the DOM after results with Prime copy, so presence alone
  // is not a loading signal.
  resultsPending() {
    const sels = [
      "[data-testid='waiting-page']",
      "[data-testid='waiting-message-default-logo']",
      "[data-testid='waiting-spinner']",
      "[aria-busy='true']",
    ];
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        if (this.isDisplayed(el)) return true;
      }
    }
    const wait = document.querySelector("[data-testid='waiting-message']");
    if (wait && this.isDisplayed(wait)) {
      const t = this.clean(wait.innerText || "");
      if (/searching|looking for|finding flight|please wait|loading/i.test(t)) return true;
    }
    return false;
  }

  async kickVirtualList() {
    const list = document.querySelector("[data-testid='itinerary-list']");
    const rail = document.querySelector("[data-testid^='sorting-tab-']");
    const target = list || rail;
    if (target) {
      try {
        target.scrollIntoView({ block: "center", inline: "nearest" });
      } catch {
        /* ignore */
      }
    }
    try {
      const top = list
        ? Math.max(0, window.scrollY + list.getBoundingClientRect().top - 72)
        : 300;
      window.scrollTo(0, top);
      window.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("resize"));
    } catch {
      /* ignore */
    }
    if (list) {
      try {
        const h = Math.max(list.scrollHeight, 1);
        for (const y of [0, 48, 160, Math.min(h - 1, 320), 1]) {
          list.scrollTop = y;
          list.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
        list.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 })
        );
        for (const child of [...list.children].slice(0, 8)) {
          try {
            child.scrollIntoView({ block: "nearest" });
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      // Background tabs often never fire rAF; do not wait on it alone.
      setTimeout(finish, 50);
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => requestAnimationFrame(finish));
      }
    });
  }

  priceButtons(card) {
    return [...card.querySelectorAll("button")].filter((b) => /price/i.test(b.textContent || ""));
  }

  parseLeg(text) {
    // e.g. "DEPARTURE · Vueling1 personal item06:502h 20'Direct10:10LGW ..."
    // Connecting cards jam an overnight offset onto arrive: "1 stop10:30+1LGW ..."
    const t = this.clean(text);
    const carrier = t.match(/·\s*(.*?)(?=\d+\s*(?:personal|cabin|checked|bag)|hand luggage|cabin bag|no bag|\d{2}:\d{2})/i)?.[1]?.trim() || null;
    const m = t.match(
      /(\d{2}:\d{2})\s*((?:\d+h)?\s*(?:\d+')?)\s*(Direct|\d+\s*stops?)\s*(\d{2}:\d{2}(?:\+\d+)?)\s*([A-Z]{3})\s+(.*?)\s*([A-Z]{3})\s+(.*)$/
    );
    return {
      carrier,
      depart: m?.[1] || null,
      arrive: m?.[4] || null,
      duration: m?.[2]?.trim() || null,
      stops: m?.[3] || null,
      from: m?.[5] || null,
      to: m?.[7] || null,
      text: t.slice(0, 200),
    };
  }

  parseOffer(card, index) {
    const raw = card.textContent || "";
    const legs = [];
    const re = /(DEPARTURE|RETURN)/g;
    const marks = [...raw.matchAll(re)];
    marks.forEach((mk, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].index : raw.length;
      const chunk = raw.slice(mk.index, end).replace(/Only \d+ tickets? left.*$/i, "");
      legs.push({ way: mk[1].toLowerCase(), ...this.parseLeg(chunk) });
    });
    const text = this.clean(card.innerText || raw);
    const price = text.match(/Non-discounted Price\s*([€$£][\s\d.,]+|[\d.,]+\s*[€$£])/i)?.[1];
    const prime = text.match(/Discounted Price\s*[€$£]?\s*[\d.,]+\s*([€$£]\s*[\d.,]+)/i)?.[1];
    const single = text.match(/Price\s*([€$£]\s*[\d.,]+)/i)?.[1];
    const primePrice = this.clean(prime) || null;
    return {
      index,
      price: this.clean(price || single) || null,
      prime: Boolean(primePrice) || /prime fare/i.test(text),
      primePrice,
      airlines: [...new Set(legs.map((l) => l.carrier).filter(Boolean))],
      ticketsLeft: Number(text.match(/Only (\d+) tickets? left/i)?.[1]) || (/Last ticket!/i.test(text) ? 1 : null),
      legs,
    };
  }

  parseOffers() {
    return this.itineraries().map((card, i) => this.parseOffer(card, i));
  }

  currentSort() {
    const tab = document.querySelector("[data-testid^='sorting-tab-'][aria-selected='true']");
    return tab ? tab.dataset.testid.replace("sorting-tab-", "") : null;
  }

  pageKind() {
    if (this.itineraries().length || /#results/.test(location.hash)) return "results";
    if (/edreams\./i.test(location.hostname)) return "home";
    return "other";
  }

  // "N of M flights match these filters" — present once the list has loaded.
  matchCounts() {
    const m = this.clean(document.body?.innerText || "").match(/(\d+) of (\d+) flights match/i);
    return m ? { shown: Number(m[1]), total: Number(m[2]) } : null;
  }

  searchExpired() {
    return /your search\b.*\bhas expired|search to .+ has expired/i.test(
      this.clean(document.body?.innerText || "")
    );
  }

  // Sidecar commands time out at 30s. Dismiss overlays once, then poll.
  // Do not re-scan every button on the page each tick — that is what made
  // results/sort hang until the extension timeout.
  //
  // The list is virtualized: "N of M flights match" (including "0 of M"
  // while the search is still running) appears before any itinerary node is
  // painted. A 1px scroll is not enough to mount rows. Wait for cards, not
  // the counter, and keep kicking the list so IntersectionObserver paints.
  //
  // Fixtures may set <html data-edreams-wait-ms="4000"> so tests do not sit
  // through the full production budget.
  waitBudgetMs(maxMs) {
    if (maxMs != null) return maxMs;
    const raw = document.documentElement.getAttribute("data-edreams-wait-ms");
    if (raw && /^\d+$/.test(raw)) return Number(raw);
    return 22000;
  }

  async waitForResults(maxMs) {
    await this.dismissConsent();
    const deadline = Date.now() + this.waitBudgetMs(maxMs);
    while (Date.now() < deadline) {
      if (this.searchExpired()) return false;
      await this.kickVirtualList();
      if (this.itineraries().length) return true;
      await this.sleep(350);
    }
    return this.itineraries().length > 0;
  }

  async sort(how = "cheapest") {
    const key = String(how || "cheapest").toLowerCase();
    const id = { cheapest: "cheapest", cheap: "cheapest", price: "cheapest", best: "recommended", recommended: "recommended", fastest: "fastest", fast: "fastest", duration: "fastest" }[key];
    if (!id) throw new Error(`Unknown sort "${how}". Use cheapest, best, or fastest.`);
    if (!(await this.waitForResults())) {
      if (this.searchExpired()) throw new Error("This eDreams search has expired. Run plugin.edreams search again.");
      if (this.matchCounts()?.shown === 0) return { sort: this.currentSort(), applied: false, count: 0 };
      throw new Error("No eDreams results on this tab. Run plugin.edreams search first.");
    }
    const tab = document.querySelector(`[data-testid='sorting-tab-${id}']`);
    if (!tab) throw new Error(`No "${id}" sort tab on this page`);
    if (tab.getAttribute("aria-selected") === "true") {
      return { sort: id, applied: false, count: this.itineraries().length };
    }
    tab.scrollIntoView({ block: "center" });
    this.fireClick(tab);
    await this.sleep(1000);
    return { sort: this.currentSort() || id, applied: true, count: this.itineraries().length };
  }

  carrierBoxes() {
    return [...document.querySelectorAll("input[data-testid^='carrier_checkbox_']")].map((input) => {
      const label = input.closest("label") || input.parentElement;
      const name = this.clean(label?.textContent || "").replace(/Only$/i, "").trim();
      return { code: input.value, name, checked: input.checked, input };
    });
  }

  airlines() {
    return this.carrierBoxes().map(({ code, name, checked }) => ({ code, name, checked }));
  }

  async airline(...args) {
    await this.dismissConsent();
    const only = /^only$/i.test(args[0] || "");
    const query = this.clean((only ? args.slice(1) : args).join(" ")).toLowerCase();
    if (!query) throw new Error("usage: airline [only] <code|name>");
    await this.waitForResults();
    const boxes = this.carrierBoxes();
    if (!boxes.length) throw new Error("No airline filters on this page. Run search first.");
    const hits = boxes.filter((b) => b.code.toLowerCase() === query || b.name.toLowerCase().includes(query));
    if (!hits.length) throw new Error(`No airline matches "${query}". Run airlines to list them.`);
    const set = (box, want) => {
      if (box.input.checked !== want) {
        box.input.scrollIntoView({ block: "center" });
        box.input.click();
      }
    };
    if (only) {
      // Uncheck everything else, keep only matches.
      for (const b of boxes) set(b, hits.includes(b));
    } else {
      for (const b of hits) set(b, !b.input.checked);
    }
    await this.sleep(1000);
    return { airlines: this.airlines().filter((b) => hits.some((h) => h.code === b.code)), count: this.itineraries().length };
  }

  async direct() {
    await this.dismissConsent();
    await this.waitForResults();
    const box = document.querySelector("[data-testid='only-direct-flights-checkbox']");
    if (!box) throw new Error("No 'Direct flights' checkbox on this page");
    const input = box.matches("input") ? box : box.querySelector("input") || box;
    input.click();
    await this.sleep(1000);
    return { direct: Boolean(input.checked), count: this.itineraries().length };
  }

  async results(...extra) {
    if (extra.length) throw new Error("results does not take a sort order. Run plugin.edreams sort cheapest, then results.");
    if (!(await this.waitForResults())) {
      if (this.searchExpired()) {
        throw new Error("This eDreams search has expired. Run plugin.edreams search again.");
      }
      const c = this.matchCounts();
      if (c && c.shown === 0) {
        return { url: location.href, count: 0, sort: this.currentSort(), matching: `0 of ${c.total} flights match`, flights: [] };
      }
      if (c && c.shown > 0) {
        throw new Error(
          `eDreams reports "${c.shown} of ${c.total} flights match" but itinerary cards did not render. Bring this tab to the front and run results again.`
        );
      }
      throw new Error(`This tab is not showing eDreams results (${this.pageKind()}: ${location.href}). Run plugin.edreams search first.`);
    }
    await this.sleep(500);
    const flights = this.parseOffers();
    return {
      url: location.href,
      title: document.title,
      count: flights.length,
      sort: this.currentSort(),
      matching: this.clean(document.body?.innerText || "").match(/(\d+) of (\d+) flights match/i)?.[0] || null,
      flights,
    };
  }

  async select(index) {
    await this.dismissConsent();
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0) throw new Error(`select <index> needs a 0-based index, got "${index}"`);
    const cards = this.itineraries();
    if (!cards.length) throw new Error("No itineraries on this page. Run plugin.edreams results first.");
    const card = cards[i];
    if (!card) throw new Error(`No itinerary at index ${i} (page has ${cards.length})`);
    const offer = this.parseOffer(card, i);
    // Prefer the plain fare button; the Prime one asks for a subscription.
    const buttons = this.priceButtons(card);
    const btn = buttons.find((b) => /non-discounted/i.test(b.textContent)) || buttons[0];
    if (!btn) throw new Error("No price button on that itinerary");
    btn.scrollIntoView({ block: "center", behavior: "instant" });
    await this.sleep(150);
    this.fireClick(btn);
    if (typeof btn.click === "function") btn.click();
    await this.sleep(1500);
    return { selected: offer, url: location.href, title: document.title };
  }

  async status() {
    const { consent } = await this.dismissConsent();
    await this.kickVirtualList();
    return {
      consentDismissed: consent,
      url: location.href,
      title: document.title,
      kind: this.pageKind(),
      sort: this.currentSort(),
      resultCount: this.itineraries().length,
      airlines: this.airlines().filter((a) => a.checked).length,
    };
  }
}
