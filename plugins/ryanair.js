// Built-in plugin: search Ryanair flights and read the results list.
//
//   browser-session-ctl --tab <id> plugin.ryanair search STN BGY 2026-10-20 2026-10-27
//   browser-session-ctl --tab <id> plugin.ryanair search STN BGY 2026-10-20
//   browser-session-ctl --tab <id> plugin.ryanair search STN BGY 2026-10-20 2026-10-27 2
//   browser-session-ctl --tab <id> plugin.ryanair sort cheapest
//   browser-session-ctl --tab <id> plugin.ryanair day outbound 2026-10-21
//   browser-session-ctl --tab <id> plugin.ryanair results
//   browser-session-ctl --tab <id> plugin.ryanair select outbound 0
//   browser-session-ctl --tab <id> plugin.ryanair status
//
// Ryanair's homepage search pod is a custom widget. `search` loads the same
// /trip/flights/select URL the site uses after you click Search. `results`
// and `select` then read the rendered flight cards. This is not a booking bot.
class Plugin {
  help() {
    return {
      namespace: "ryanair",
      methods: {
        help: "Show this message.",
        search:
          "search <from> <to> <depart> [return] [adults] — open Ryanair flight select. Airport codes (STN, BGY, DUB). Dates as YYYY-MM-DD or MM/DD/YYYY. Omit return (or pass oneway) for one-way. Then results.",
        sort: "sort [cheapest|earliest|latest|regular] — open Sort flights by and pick an option. Default: cheapest.",
        day: "day <outbound|return> <YYYY-MM-DD> — click a date tab on that leg. Then results.",
        results:
          "results — wait for flight cards and return outbound (and return) flights in the page's current order. Does not change sort.",
        select:
          "select <outbound|return> <index|FR…> — click Select on one card (0-based index from results, or a flight number like FR2738 / 2738). Then clicks Basic if a fare sheet opens. Does not book.",
        close: "close — dismiss the cookie banner (No, thanks). Never clicks Yes, I agree. Other methods that touch the page do this first.",
        status: "status — home, results, or other, plus origin/destination/dates from the URL and card counts.",
      },
    };
  }

  airport(value) {
    const code = String(value || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) {
      throw new Error(`"${value}" is not a 3-letter airport code (e.g. STN, BGY, DUB).`);
    }
    return code;
  }

  parseSearchArgs(from, to, depart, ...rest) {
    if (!from || !to || !depart) throw new Error("usage: search <from> <to> <depart> [return] [adults]");
    const params = {
      from: this.airport(from),
      to: this.airport(to),
      depart: bsc.dates.toIso(depart),
      returnDate: null,
      adults: 1,
    };
    for (const token of rest) {
      if (token == null || token === "") continue;
      const lower = String(token).toLowerCase();
      if (bsc.dates.looksLikeDate(token)) params.returnDate = bsc.dates.toIso(token);
      else if (lower === "oneway" || lower === "one-way") params.returnDate = null;
      else if (/^\d+$/.test(token)) {
        params.adults = Number(token);
        if (params.adults < 1 || params.adults > 9) throw new Error("adults must be between 1 and 9");
      } else throw new Error(`Unrecognized argument "${token}".`);
    }
    params.isReturn = Boolean(params.returnDate);
    return params;
  }

  searchUrl(p) {
    const q = new URLSearchParams({
      adults: String(p.adults),
      teens: "0",
      children: "0",
      infants: "0",
      dateOut: p.depart,
      isConnectedFlight: "false",
      discount: "0",
      isReturn: p.isReturn ? "true" : "false",
      promoCode: "",
      originIata: p.from,
      destinationIata: p.to,
    });
    if (p.returnDate) q.set("dateIn", p.returnDate);
    return `https://www.ryanair.com/gb/en/trip/flights/select?${q}`;
  }

  search(from, to, depart, ...rest) {
    const params = this.parseSearchArgs(from, to, depart, ...rest);
    const url = this.searchUrl(params);
    setTimeout(() => location.assign(url), 50);
    return { ...params, url };
  }

  cookieButton() {
    const nodes = document.querySelectorAll("button, [role='button']");
    for (const el of nodes) {
      if (/^no,\s*thanks$/i.test(bsc.clean(el.textContent)) && bsc.isDisplayed(el)) return el;
    }
    return null;
  }

  async dismissCookies() {
    const btn = this.cookieButton();
    if (!btn) return { cookies: false };
    bsc.click(btn);
    for (let i = 0; i < 8; i += 1) {
      await bsc.sleep(150);
      if (!this.cookieButton()) return { cookies: true };
    }
    return { cookies: true };
  }

  async close() {
    return this.dismissCookies();
  }

  pageKind() {
    if (/\/trip\/flights\/select/i.test(location.pathname)) return "results";
    if (/ryanair\./i.test(location.hostname) && /\/(gb|ie|it|es|fr|de)\//i.test(location.pathname)) {
      return "home";
    }
    if (/ryanair\./i.test(location.hostname)) return "home";
    return "other";
  }

  urlParams() {
    const q = new URLSearchParams(location.search);
    return {
      from: q.get("originIata") || q.get("tpOriginIata") || q.get("Origin"),
      to: q.get("destinationIata") || q.get("tpDestinationIata"),
      depart: q.get("dateOut") || q.get("tpStartDate") || q.get("DateOut"),
      returnDate: q.get("dateIn") || q.get("tpEndDate") || q.get("DateIn"),
      adults: Number(q.get("adults") || q.get("tpAdults") || q.get("ADT") || 0) || null,
    };
  }

  uniqueCards(els) {
    const roots = els.filter((el) => !els.some((other) => other !== el && other.contains(el)));
    const seen = new Set();
    const out = [];
    for (const el of roots) {
      const parsed = this.parseFlight(el, 0, "outbound");
      const key = `${parsed.flight}|${parsed.depart}|${parsed.arrive}|${parsed.price}`;
      if (!parsed.flight || seen.has(key)) continue;
      seen.add(key);
      out.push(el);
    }
    return out.length ? out : roots;
  }

  flightCards() {
    const tagged = [...document.querySelectorAll("flight-card")].filter((el) => bsc.isDisplayed(el));
    if (tagged.length) return this.uniqueCards(tagged);
    const byClass = [...document.querySelectorAll("[class*='flight-card']")].filter(
      (el) => bsc.isDisplayed(el) && /FR\s*\d+/i.test(el.innerText || "") && /Select/i.test(el.innerText || "")
    );
    if (byClass.length) return this.uniqueCards(byClass);
    const fallback = [];
    for (const btn of document.querySelectorAll("button")) {
      if (!/^select$/i.test(bsc.clean(btn.textContent)) || !bsc.isDisplayed(btn)) continue;
      let el = btn.parentElement;
      for (let i = 0; i < 8 && el; i += 1) {
        const t = el.innerText || "";
        if (/FR\s*\d+/i.test(t) && /Select/i.test(t) && t.length < 800) {
          fallback.push(el);
          break;
        }
        el = el.parentElement;
      }
    }
    return this.uniqueCards(fallback);
  }

  journeyTitle(card) {
    let el = card;
    while (el) {
      let sib = el.previousElementSibling;
      while (sib) {
        const heading = /^H[1-3]$/.test(sib.tagName) ? sib : sib.querySelector?.("h1, h2, h3");
        const text = bsc.clean(heading?.textContent || "");
        if (heading && /\bto\b/i.test(text) && text.length < 80) return text;
        sib = sib.previousElementSibling;
      }
      el = el.parentElement;
    }
    return null;
  }

  parseFlight(card, index, leg) {
    const t = bsc.clean(card.innerText || "");
    const num = t.match(/FR\s*(\d+)/i)?.[1];
    const times = [...t.matchAll(/\b(\d{2}:\d{2})\b/g)].map((m) => m[1]);
    const duration = t.match(/(\d+h\s*\d+m)/i)?.[1] || null;
    const price = t.match(/((?:£|€|\$)\s*[\d.,]+)/)?.[1] || null;
    const seats = Number(t.match(/(\d+)\s*seats? left/i)?.[1]) || null;
    const operatedBy = t.match(/Operated by\s+([A-Za-z][A-Za-z ]+?)(?=\s+\d{2}:|$)/i)?.[1]?.trim() || null;
    return {
      index,
      leg,
      flight: num ? `FR${num}` : null,
      depart: times[0] || null,
      arrive: times[1] || null,
      duration,
      price: price ? bsc.clean(price) : null,
      seatsLeft: seats,
      operatedBy,
      title: this.journeyTitle(card),
    };
  }

  splitByLeg(cards) {
    const outbound = [];
    const inbound = [];
    let inboundStarted = false;
    let lastTitle = null;
    for (const card of cards) {
      const title = this.journeyTitle(card);
      if (title && lastTitle && title !== lastTitle) inboundStarted = true;
      if (title) lastTitle = title;
      if (inboundStarted) inbound.push(card);
      else outbound.push(card);
    }
    if (!inbound.length && cards.length > 1) {
      const mid = cards.findIndex((c, i) => i > 0 && this.journeyTitle(c) && this.journeyTitle(c) !== this.journeyTitle(cards[0]));
      if (mid > 0) return { outbound: cards.slice(0, mid), inbound: cards.slice(mid) };
    }
    return { outbound, inbound };
  }

  parseOffers() {
    const cards = this.flightCards();
    const { outbound, inbound } = this.splitByLeg(cards);
    return {
      outbound: outbound.map((c, i) => this.parseFlight(c, i, "outbound")),
      inbound: inbound.map((c, i) => this.parseFlight(c, i, "return")),
    };
  }

  dateTabs() {
    return [...document.querySelectorAll("button")].filter((b) => {
      if (!bsc.isDisplayed(b)) return false;
      return /^\d{1,2}[A-Z][a-z]{2}\b/.test(bsc.clean(b.textContent).replace(/\s+/g, ""));
    });
  }

  async waitForResults(maxMs = 18000) {
    await this.dismissCookies();
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (this.flightCards().length) return true;
      if (/no flights|we don.t fly|sold out/i.test(document.body?.innerText || "")) return false;
      await bsc.sleep(350);
    }
    return this.flightCards().length > 0;
  }

  async sort(how = "cheapest") {
    const key = String(how || "cheapest").toLowerCase();
    const want = {
      cheapest: /cheapest|lowest price|price/i,
      price: /cheapest|lowest price|price/i,
      cheap: /cheapest|lowest price|price/i,
      earliest: /early|depart/i,
      latest: /late|latest/i,
      regular: /regular|recommended|default/i,
      recommended: /regular|recommended|default/i,
    }[key];
    if (!want) throw new Error(`Unknown sort "${how}". Use cheapest, earliest, latest, or regular.`);
    if (!(await this.waitForResults())) throw new Error("No Ryanair flights on this tab. Run plugin.ryanair search first.");
    const openers = [...document.querySelectorAll("button")].filter((b) =>
      /^sort flights by/i.test(bsc.clean(b.textContent))
    );
    if (!openers.length) throw new Error("No Sort flights by control on this page.");
    bsc.click(openers[0]);
    await bsc.sleep(400);
    const opt = [...document.querySelectorAll("button, [role='option'], [role='menuitem'], li, a")].find(
      (el) => bsc.isDisplayed(el) && want.test(bsc.clean(el.textContent)) && !/^sort flights by/i.test(bsc.clean(el.textContent))
    );
    if (!opt) throw new Error(`No sort option matching "${how}".`);
    bsc.click(opt);
    await bsc.sleep(800);
    return { sort: key, applied: true, count: this.flightCards().length };
  }

  monthShort(iso) {
    return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
      Number(iso.slice(5, 7)) - 1
    ];
  }

  async day(which, date) {
    const leg = String(which || "").toLowerCase();
    if (leg !== "outbound" && leg !== "return" && leg !== "returning") {
      throw new Error("usage: day <outbound|return> <YYYY-MM-DD>");
    }
    if (!date) throw new Error("usage: day <outbound|return> <YYYY-MM-DD>");
    const iso = bsc.dates.toIso(date);
    const needle = `${Number(iso.slice(8, 10))}${this.monthShort(iso)}`;
    if (!(await this.waitForResults())) throw new Error("No Ryanair flights on this tab. Run plugin.ryanair search first.");
    const tabs = this.dateTabs();
    if (!tabs.length) throw new Error("No date tabs on this page.");
    const mid = Math.ceil(tabs.length / 2);
    const pool = leg === "outbound" ? tabs.slice(0, mid) : tabs.slice(mid);
    const hit = pool.find((b) => bsc.clean(b.textContent).replace(/\s+/g, "").startsWith(needle));
    if (!hit) {
      throw new Error(
        `No ${leg} date tab for ${iso}. Visible: ${tabs.map((b) => bsc.clean(b.textContent).slice(0, 24)).join(" | ")}`
      );
    }
    hit.scrollIntoView({ block: "center" });
    bsc.click(hit);
    await bsc.sleep(1000);
    return { leg: leg === "outbound" ? "outbound" : "return", date: iso, count: this.flightCards().length };
  }

  async results(...extra) {
    if (extra.length) throw new Error("results does not take extra arguments. Run plugin.ryanair sort cheapest, then results.");
    if (!(await this.waitForResults())) {
      throw new Error(`This tab is not showing Ryanair flights (${this.pageKind()}: ${location.href}). Run plugin.ryanair search first.`);
    }
    const { outbound, inbound } = this.parseOffers();
    const params = this.urlParams();
    return {
      url: location.href,
      title: document.title,
      from: params.from,
      to: params.to,
      depart: params.depart,
      returnDate: params.returnDate,
      count: outbound.length + inbound.length,
      outbound,
      inbound,
    };
  }

  selectButton(card) {
    return [...card.querySelectorAll("button")].find((b) => /^select$/i.test(bsc.clean(b.textContent)) && bsc.isDisplayed(b));
  }

  async select(legOrIndex, maybeIndex) {
    await this.dismissCookies();
    if (!(await this.waitForResults())) throw new Error("No Ryanair flights on this tab. Run plugin.ryanair results first.");
    const { outbound, inbound } = this.splitByLeg(this.flightCards());
    let cards = outbound;
    let token = String(legOrIndex ?? "");
    let which = "outbound";
    if (/^(outbound|return|returning|inbound)$/i.test(token)) {
      which = /outbound/i.test(token) ? "outbound" : "return";
      cards = which === "outbound" ? outbound : inbound;
      token = String(maybeIndex ?? "");
    } else if (maybeIndex != null) {
      throw new Error("usage: select <outbound|return> <index|FR…>");
    }
    if (!token) throw new Error("usage: select <outbound|return> <index|FR…>");
    const n = Number(token);
    let card;
    let index;
    if (Number.isInteger(n) && n >= 0 && String(n) === token) {
      card = cards[n];
      index = n;
      if (!card) throw new Error(`No ${which} flight at index ${n} (page has ${cards.length})`);
    } else {
      const want = token.toUpperCase().replace(/\s+/g, "");
      index = cards.findIndex((c) => {
        const f = this.parseFlight(c, 0, which).flight;
        return f && (f === want || f === `FR${want}` || f.replace(/^FR/, "") === want.replace(/^FR/, ""));
      });
      if (index < 0) throw new Error(`No ${which} flight matching "${token}".`);
      card = cards[index];
    }
    const offer = this.parseFlight(card, index, which);
    const btn = this.selectButton(card);
    if (!btn) throw new Error("No Select button on that card.");
    btn.scrollIntoView({ block: "center", behavior: "instant" });
    await bsc.sleep(150);
    bsc.click(btn);
    await bsc.sleep(800);
    const basic = [...document.querySelectorAll("button, [role='button']")].find((el) => {
      const t = bsc.clean(el.textContent);
      return bsc.isDisplayed(el) && /basic/i.test(t) && /fare|select|continue|£|€|\$/i.test(t);
    });
    if (basic) {
      bsc.click(basic);
      await bsc.sleep(800);
    }
    return { selected: offer, url: location.href, title: document.title };
  }

  async status() {
    const { cookies } = await this.dismissCookies();
    const params = this.urlParams();
    const { outbound, inbound } = this.parseOffers();
    return {
      cookiesDismissed: cookies,
      url: location.href,
      title: document.title,
      kind: this.pageKind(),
      ...params,
      outboundCount: outbound.length,
      inboundCount: inbound.length,
    };
  }
}
