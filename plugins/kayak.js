// Built-in plugin: search Kayak rental cars and read the results list.
//
//   browser-session-ctl --tab <id> plugin.kayak carsearch LCA 2026-10-22 2026-10-28 23 4
//   browser-session-ctl --tab <id> plugin.kayak carsearch LCA 2026-10-22 2026-10-28 23 4 van
//   browser-session-ctl --tab <id> plugin.kayak carResults 10
//   browser-session-ctl --tab <id> plugin.kayak status
//
// Kayak's car results URL carries everything (place, dates, hours, sort, filter),
// so `carsearch` just navigates there; `carResults` reads the rendered cards.
// Each card lists the car, the rental agency, and every booking site that sells
// it (Expedia, Priceline, EconomyBookings, Booking.com, ...) with its total.
class Plugin {
  help() {
    return {
      namespace: "kayak",
      methods: {
        help: "Show this message.",
        carsearch:
          "carsearch <place> <pickup-date> <dropoff-date> [pickup-hour] [dropoff-hour] [class...] — open Kayak car results, cheapest first. place: airport code (LCA) or a Kayak slug (Larnaca-LCA). Dates YYYY-MM-DD. Hours are whole hours, 0-23 (default 10). class: van | suv | small | medium | large | luxury | commercial | convertible | wagon | 4wd (Kayak has no separate minivan; its Van class holds the minivans and people carriers). Then carResults.",
        carResults:
          "carResults [max] — wait for the list, return cars (model, class, seats, bags, doors, agency, pickup, cancellation, rating, total, offers[]) in the page's order. offers lists every booking site with its total.",
        status: "status — the search this tab shows: place, dates, sort, filter, result count.",
      },
    };
  }

  hour(value, fallback) {
    const h = value === undefined || value === "" ? fallback : Number(String(value).replace(/h$/i, ""));
    if (!Number.isInteger(h) || h < 0 || h > 23) throw new Error(`Hour "${value}" must be a whole hour 0-23.`);
    return h;
  }

  date(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) throw new Error(`Unrecognized date "${value}". Use YYYY-MM-DD.`);
    return value;
  }

  carsearch(place, pickup, dropoff, ...rest) {
    if (!place || !pickup || !dropoff) {
      throw new Error("usage: carsearch <place> <pickup-date> <dropoff-date> [pickup-hour] [dropoff-hour] [class...]");
    }
    const hours = [];
    const classes = [];
    for (const token of rest) {
      if (/^\d{1,2}h?$/i.test(String(token))) hours.push(token);
      else classes.push(String(token).toUpperCase());
    }
    const from = `${this.date(pickup)}-${this.hour(hours[0], 10)}h`;
    const to = `${this.date(dropoff)}-${this.hour(hours[1], 10)}h`;
    const query = ["sort=price_a"];
    if (classes.length) query.push(`fs=carclass=${classes.join(",")}`);
    const url = `https://www.kayak.com/cars/${encodeURIComponent(place)}/${from}/${to}?${query.join("&")}`;
    // Navigate after this call returns; assigning now would unload the page first.
    setTimeout(() => location.assign(url), 50);
    return { url };
  }

  // One element per car: climb from each "View deal" button to the last ancestor
  // that holds only that one button.
  carCards() {
    const isDeal = (b) => /^View deal$/i.test(b.textContent.trim());
    const deals = (root) => [...root.querySelectorAll("a, button, div[role=button]")].filter(isDeal);
    const cards = [];
    for (const btn of deals(document)) {
      let el = btn;
      while (el.parentElement && deals(el.parentElement).length === 1) el = el.parentElement;
      if (!cards.includes(el)) cards.push(el);
    }
    return cards;
  }

  parseCar(el, index) {
    const raw = (el.innerText || "").replace(/\n(or similar)/g, " $1");
    const lines = raw.split("\n").map((s) => s.trim()).filter(Boolean);
    const iModel = lines.findIndex((l) => / or similar /.test(l));
    const m = iModel >= 0 ? lines[iModel].match(/^(.+?) or similar (.+)$/) : null;
    // some cars do not name a model: just the class, then "View deal for more details."
    const iUnnamed = iModel < 0 ? lines.findIndex((l) => /^View deal for more details/i.test(l)) : -1;
    const iFirst = iModel >= 0 ? iModel : iUnnamed;
    const nums = [];
    for (let i = iFirst + 1; i < lines.length && /^\d+$/.test(lines[i]) && nums.length < 3; i += 1) nums.push(lines[i]);
    const iPrice = lines.findIndex((l) => /^\$[\d,]+$/.test(l));
    const iDeal = lines.findIndex((l) => /^View deal$/i.test(l));
    const offers = [];
    if (iPrice > 0) offers.push({ site: lines[iPrice - 1], total: lines[iPrice] });
    for (let i = iDeal + 1; i < lines.length - 1; i += 1) {
      if (/^\$[\d,]+$/.test(lines[i + 1]) && !/^\$[\d,]+$/.test(lines[i]) && !/^\d+ more sites$/.test(lines[i])) {
        offers.push({ site: lines[i], total: lines[i + 1] });
        i += 1;
      }
    }
    const iRate = lines.findIndex((l) => /^\d\.\d$/.test(l));
    const iLoc = lines.findIndex((l) => /^[A-Z]{3}: /.test(l));
    const agency = [...el.querySelectorAll("img[alt]")].map((i) => i.alt.match(/^Car agency: (.+)$/)?.[1]).find(Boolean) || null;
    const cheapest = offers.map((o) => o.total).sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")))[0] || null;
    return {
      index,
      model: m?.[1] || null,
      class: m?.[2] || (iUnnamed > 0 ? lines[iUnnamed - 1] : null),
      seats: nums[0] || null,
      bags: nums[1] || null,
      doors: nums[2] || null,
      agency,
      pickup: iLoc >= 0 ? `${lines[iLoc]}${lines[iLoc + 1] ? ` (${lines[iLoc + 1]})` : ""}` : null,
      cancellation: lines.find((l) => /^Free cancellation|^Cancellation fees|^Non-refundable/i.test(l)) || null,
      rating: iRate >= 0 ? `${lines[iRate]} ${lines[iRate + 1] || ""}`.trim() : null,
      total: cheapest,
      offers,
      ad: lines.includes("Ad"),
    };
  }

  async carResults(max = 20) {
    await bsc.waitFor(() => this.carCards().length > 0 && /\d+ results/.test(document.body.innerText), 80, 500);
    await bsc.sleep(1500);
    const cars = this.carCards().map((el, i) => this.parseCar(el, i));
    const count = document.body.innerText.match(/(\d+) results/)?.[1] || null;
    return { url: location.href, count: count ? Number(count) : null, loaded: cars.length, cars: cars.slice(0, Number(max) || 20) };
  }

  status() {
    const url = new URL(location.href);
    const text = document.body.innerText;
    return {
      url: location.href,
      place: text.match(/Airport or city\s*([^\n]+)/)?.[1]?.trim() || null,
      path: url.pathname,
      sort: url.searchParams.get("sort"),
      filter: url.searchParams.get("fs"),
      count: text.match(/(\d+) results/)?.[1] || null,
      loaded: this.carCards().length,
    };
  }
}
