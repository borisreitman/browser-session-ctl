// Built-in plugin: read and search Upwork Messages (www.upwork.com/ab/messages/).
//
//   browser-session-ctl --tab <id> plugin.upwork-messages rooms
//   browser-session-ctl --tab <id> plugin.upwork-messages thread            # the open room, whole history
//   browser-session-ctl --tab <id> plugin.upwork-messages open "Zara"       # switch rooms
//   browser-session-ctl --tab <id> plugin.upwork-messages all > all.json    # every room, every message
//   browser-session-ctl --tab <id> plugin.upwork-messages find invoice --all
//
// The Messages app is a Vue SPA. The left list is <a data-test="room-list-item"
// id="room_..."> (a router link), and the open conversation is a list of
// <div class="story-list-item-root"> inside the scroller #story-viewport. Upwork only
// keeps the newest messages in the DOM until you scroll up, so `thread` scrolls to the
// top until the count stops growing. Consecutive messages from one person have no
// header, so the author is carried forward. Timestamps come from the hover tooltip
// ("Friday, Sep 18 12:53 PM") which has no year; the year is recovered by finding the
// latest year in which that date falls on that weekday.
//
// Clicking a room is a client-side route change, so the plugin instance survives it and
// `all` / `find --all` can walk every room in one call. Read-only: it never types in
// the composer, sends, edits, deletes, saves or marks messages.
class Plugin {
  help() {
    return {
      namespace: "upwork-messages",
      methods: {
        help: "Show this message.",
        status: "status — url, open room, rooms loaded, messages currently in the DOM.",
        rooms:
          "rooms [--unread] [--limit N] — every conversation in the left list (scrolls to load them all): {id, name, date, job, preview, url}.",
        open: "open <id|name-substring> — switch to a room (client-side; no page reload).",
        thread:
          "thread [--room X] [--limit N] [--no-system] — the whole open room (or room X), scrolled to the beginning: {room, count, first, last, messages:[{id, author, when, iso, text, attachments, quote, system, edited}]}. --limit N keeps the newest N.",
        all: "all [--limit-rooms N] [--room X] [--no-system] [--limit N] [--refresh] [--budget SECS] — every room's thread. Each command runs ~12s, so this resumes: it returns {done:false, remaining} until every room is loaded (cached in the page), then {done:true, threads}. Large; redirect stdout to a file.",
        find:
          "find <text...> [--all] [--room X] [--regex] [--author A] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--context N] — case-insensitive search of message text, attachment names and quotes in the open room (or every room with --all). Returns {query, rooms, matches:[{room, id, author, when, iso, snippet, context}]}.",
      },
    };
  }

  // ---------------------------------------------------------------- helpers

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  clean(text) {
    return String(text || "").replace(/[‎‏]/g, "").replace(/ /g, " ").replace(/[ \t]+/g, " ").trim();
  }

  parseArgs(args) {
    const valued = new Set(["limit", "limit-rooms", "room", "author", "since", "until", "context", "budget"]);
    const bools = new Set(["unread", "all", "regex", "no-system", "refresh", "partial"]);
    const flags = {};
    const words = [];
    for (let i = 0; i < args.length; i += 1) {
      const a = String(args[i]);
      if (a.startsWith("--") && valued.has(a.slice(2))) {
        flags[a.slice(2)] = String(args[i + 1] === undefined ? "" : args[i + 1]);
        i += 1;
      } else if (a.startsWith("--") && bools.has(a.slice(2))) {
        flags[a.slice(2)] = true;
      } else {
        words.push(a);
      }
    }
    return { words, flags };
  }

  isSignedOut() {
    return /\/ab\/account-security\/login|\/nx\/signup|just a moment/i.test(location.href + " " + document.title);
  }

  requireMessages() {
    if (!/\/ab\/messages\//.test(location.pathname)) {
      throw new Error("Not on Upwork Messages (" + location.pathname + "). Open https://www.upwork.com/ab/messages/rooms/ first.");
    }
  }

  // ------------------------------------------------------------------ rooms

  roomLinks() {
    return [...document.querySelectorAll("a[data-test='room-list-item']")];
  }

  roomScroller() {
    const first = this.roomLinks()[0];
    for (let e = first && first.parentElement; e; e = e.parentElement) {
      if (e.scrollHeight > e.clientHeight + 5 && /auto|scroll/.test(getComputedStyle(e).overflowY)) return e;
    }
    return null;
  }

  currentRoomId() {
    const m = location.pathname.match(/\/rooms\/(room_[0-9a-f]+)/);
    return m ? m[1] : null;
  }

  parseRoom(a) {
    const id = a.id || null;
    const name = this.clean((a.querySelector("[data-test='room-name']") || {}).innerText);
    const date = this.clean((a.querySelector(".timestamp") || {}).innerText);
    const desc = a.querySelector(".item-descriptions");
    const lines = desc
      ? [...desc.children].map((c) => this.clean(c.innerText)).filter(Boolean)
      : [];
    return {
      id,
      name,
      date,
      job: lines.length > 1 ? lines[0] : null,
      preview: lines.length ? lines[lines.length - 1] : null,
      url: id ? "https://www.upwork.com/ab/messages/rooms/" + id : null,
      active: id === this.currentRoomId(),
    };
  }

  // Scroll the room list down until no new rooms appear.
  async loadAllRooms() {
    await bsc.waitFor(() => (this.roomLinks().length ? true : null), 40, 250);
    const scroller = this.roomScroller();
    if (!scroller) return;
    const start = scroller.scrollTop;
    let last = -1;
    let still = 0;
    for (let i = 0; i < 200 && still < 3; i += 1) {
      scroller.scrollTop = scroller.scrollHeight;
      await this.sleep(400);
      const n = this.roomLinks().length;
      still = n === last ? still + 1 : 0;
      last = n;
    }
    scroller.scrollTop = start;
  }

  async rooms(...args) {
    this.requireMessages();
    const { flags } = this.parseArgs(args);
    if (flags.unread) {
      const box = [...document.querySelectorAll("input[type=checkbox]")].find((i) => /unread/i.test((i.closest("label") || i.parentElement || {}).innerText || i.getAttribute("aria-label") || ""));
      if (box && !box.checked) {
        bsc.click(box);
        await this.sleep(800);
      }
    }
    await this.loadAllRooms();
    let list = this.roomLinks().map((a) => this.parseRoom(a));
    if (flags.limit) list = list.slice(0, Number(flags.limit));
    return { count: list.length, ...(document.hidden ? { hidden: true, warning: this.hiddenNote() } : {}), rooms: list };
  }

  findRoom(query) {
    const q = String(query).toLowerCase();
    const links = this.roomLinks();
    return (
      links.find((a) => a.id === q || a.id === "room_" + q) ||
      links.find((a) => this.clean((a.querySelector("[data-test='room-name']") || {}).innerText).toLowerCase().includes(q)) ||
      links.find((a) => this.clean(a.innerText).toLowerCase().includes(q)) ||
      null
    );
  }

  async open(...args) {
    this.requireMessages();
    const query = args.join(" ").trim();
    if (!query) throw new Error("open: expected a room id or part of a name");
    return this.openRoom(query);
  }

  async openRoom(query) {
    let a = this.findRoom(query);
    if (!a) {
      await this.loadAllRooms();
      a = this.findRoom(query);
    }
    if (!a) throw new Error('No room matching "' + query + '". Run `rooms` to list them.');
    const id = a.id;
    if (this.currentRoomId() !== id) {
      a.scrollIntoView({ block: "center" });
      bsc.click(a);
      const ok = await bsc.waitFor(() => (this.currentRoomId() === id && this.stories().length ? true : null), 60, 250);
      if (!ok) throw new Error("Room did not open: " + id);
      await this.sleep(600);
    }
    return this.parseRoom(this.roomLinks().find((x) => x.id === id) || a);
  }

  // --------------------------------------------------------------- messages

  scroller() {
    return document.querySelector("#story-viewport");
  }

  stories() {
    return [...document.querySelectorAll("#story-viewport .story-list-item-root")];
  }

  // The message pane is a reversed (chat-style) scroller: scrollTop 0 is the NEWEST message
  // and older ones are at negative values. Setting a huge negative value clamps to the oldest
  // loaded message; in a normal scroller the browser clamps it to 0, which is the top there.
  scrollToOldest(sc) {
    sc.scrollTop = -sc.scrollHeight;
    if (sc.scrollTop === 0 && sc.scrollHeight > sc.clientHeight) sc.scrollTop = 0;
    return sc.scrollTop;
  }

  hiddenNote() {
    return document.hidden
      ? "This tab is hidden (background tab or Chrome window behind other windows). Upwork loads older messages and rooms only when they scroll into view in a visible tab, so the result is cut off. Bring this tab's Chrome window to the front and run the command again."
      : null;
  }

  // Poll until the number of stories exceeds `n`, up to `ms`. Returns true if it grew.
  async growsWithin(n, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await this.sleep(100);
      if (this.stories().length > n) return true;
    }
    return this.stories().length > n;
  }

  // Load older history. Each round: jump to the oldest loaded message and wait for more; if
  // nothing arrives, send a genuine (trusted) mouse wheel over the pane, which Upwork honours
  // when a programmatic scroll stalls, and wait again. Only after several rounds in which
  // neither produces anything is the start of the conversation assumed. A count that has merely
  // stopped growing is NOT proof of that: the page can lag well behind the scrolling.
  async loadAllStories(deadline) {
    const sc = await bsc.waitFor(() => (this.scroller() && this.stories().length ? this.scroller() : null), 60, 250);
    if (!sc) return { loaded: 0, reachedTop: false };
    const start = sc.scrollTop;
    let idle = 0;
    while (idle < 3 && Date.now() < deadline) {
      let n = this.stories().length;
      this.scrollToOldest(sc);
      if (await this.growsWithin(n, 700)) {
        idle = 0;
        continue;
      }
      n = this.stories().length;
      let grew = false;
      try {
        await bsc.scrollTrusted({ selector: "#story-viewport", direction: "up", amount: 600, settle: 50 });
        grew = await this.growsWithin(n, 1500);
      } catch (e) {
        grew = await this.growsWithin(n, 1500); // debugger unavailable: rely on programmatic scrolling
      }
      idle = grew ? 0 : idle + 1;
    }
    const loaded = this.stories().length;
    sc.scrollTop = start; // back where it was (0 = newest in the reversed pane)
    return { loaded, reachedTop: idle >= 3 };
  }

  // "Friday, Sep 18 12:53 PM" / "Today 10:13 AM" / "Yesterday 9:00 PM" -> ISO-ish local time.
  parseWhen(s) {
    if (!s) return null;
    const t = String(s).replace(/\s+/g, " ").trim();
    const time = t.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
    if (!time) return null;
    let h = Number(time[1]) % 12;
    if (/pm/i.test(time[3])) h += 12;
    const min = Number(time[2]);
    const now = new Date();
    let base = null;
    if (/^today/i.test(t)) base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    else if (/^yesterday/i.test(t)) base = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    else {
      const d = t.match(/^(?:(\w+),\s+)?(\w{3})\w*\s+(\d{1,2})(?:,?\s+(\d{4}))?/);
      if (!d) return null;
      const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
      const mon = months.indexOf(d[2].toLowerCase());
      if (mon < 0) return null;
      const day = Number(d[3]);
      if (d[4]) base = new Date(Number(d[4]), mon, day);
      else {
        const wd = d[1] ? d[1].slice(0, 3).toLowerCase() : null;
        const names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
        for (let y = now.getFullYear(); y > now.getFullYear() - 9 && !base; y -= 1) {
          const c = new Date(y, mon, day);
          if (c > now) continue;
          if (!wd || names[c.getDay()] === wd) base = c;
        }
        if (!base) return null;
      }
    }
    base.setHours(h, min, 0, 0);
    const p = (n) => String(n).padStart(2, "0");
    return base.getFullYear() + "-" + p(base.getMonth() + 1) + "-" + p(base.getDate()) + "T" + p(base.getHours()) + ":" + p(base.getMinutes());
  }

  parseStory(el, carry) {
    const id = (el.id || "").replace(/^story_/, "") || null;
    const system = el.querySelector("[data-test='system-story']");
    const tip = [...el.querySelectorAll("[data-test='popper']")].map((p) => this.clean(p.textContent)).find((t) => /\d{1,2}:\d{2}\s*[AP]M/i.test(t));
    const when = tip || null;
    const timeShort = this.clean((el.querySelector(".story-timestamp, .header-timestamp") || {}).textContent) || null;

    if (system) {
      const text = this.clean((el.querySelector("[data-test='system-story-message']") || system).innerText);
      return { id, author: null, when, iso: this.parseWhen(when), time: timeShort, text, system: true, attachments: [], quote: null, edited: false };
    }

    const nameEl = el.querySelector(".user-name");
    const author = nameEl ? this.clean(nameEl.innerText) : carry.author;
    if (nameEl) carry.author = author;

    const body = el.querySelector("[data-test='story-message']");
    // Cards without a text body (meeting/contract/milestone events) fall back to the whole section.
    const section = el.querySelector(".story-section") || el;
    const raw = body ? body.innerText : section.innerText;
    const text = raw.replace(/[‎‏]/g, "").replace(/ /g, " ").replace(/\n{3,}/g, "\n\n").trim();
    const quoteEl = el.querySelector("[data-test='story-quote-attachment']");
    const attachments = [...el.querySelectorAll(".attachment-item")].map((it) => {
      const a = it.querySelector("a.name, a[data-ev-label='attachment_link']");
      const size = this.clean((it.querySelector(".file-content") || {}).innerText);
      return { name: this.clean((a || it).innerText), url: a ? a.href : null, size: size || null };
    });
    // Collapsed attachment groups show only the first file name in a toggler.
    if (!attachments.length) {
      const tog = el.querySelector(".files-toggle");
      if (tog) attachments.push({ name: this.clean(tog.innerText), url: null, size: null });
    }
    return {
      id,
      author,
      when,
      iso: this.parseWhen(when),
      time: timeShort,
      text,
      system: false,
      event: !body,
      attachments,
      quote: quoteEl ? this.clean(quoteEl.innerText) : null,
      edited: !!el.querySelector("[class*='edited'], [data-test*='edited']"),
    };
  }

  readMessages() {
    const carry = { author: null };
    const out = this.stories().map((el) => this.parseStory(el, carry));
    // Follow-up messages from the same person show no time in the DOM (only on hover).
    // Give them the previous known time and mark it approximate.
    let prev = null;
    for (const m of out) {
      if (m.when) prev = m;
      else if (prev) {
        m.when = prev.when;
        m.iso = prev.iso;
        m.approxTime = true;
      }
    }
    return out;
  }

  roomTitle() {
    const active = this.roomLinks().find((a) => a.id === this.currentRoomId());
    if (active) return this.clean((active.querySelector("[data-test='room-name']") || {}).innerText);
    const t = new URL(location.href).searchParams.get("pageTitle");
    return t || null;
  }

  async thread(...args) {
    this.requireMessages();
    const { flags } = this.parseArgs(args);
    if (flags.room) await this.openRoom(flags.room);
    return this.readThread(flags);
  }

  deadlineFor(flags, startedAt) {
    // The sidecar gives each command 30s; stay well inside it.
    const secs = flags.budget ? Number(flags.budget) : 12;
    return (startedAt || Date.now()) + secs * 1000;
  }

  async readThread(flags, deadline) {
    if (!this.currentRoomId()) throw new Error("No room is open. Use `open <name>` or pass --room.");
    const room = this.parseRoom(this.roomLinks().find((a) => a.id === this.currentRoomId()) || document.createElement("a"));
    const { reachedTop } = await this.loadAllStories(deadline || this.deadlineFor(flags));
    // An unfinished load returns progress only (a big partial list would risk the 30s limit
    // and is not useful); run the command again to continue. --partial returns it anyway.
    let messages = reachedTop || flags.partial ? this.readMessages() : [];
    const loadedStories = this.stories().length;
    if (flags["no-system"]) messages = messages.filter((m) => !m.system);
    if (flags.limit) messages = messages.slice(-Number(flags.limit));
    return {
      room: { id: this.currentRoomId(), name: room.name || this.roomTitle(), job: room.job, url: location.origin + location.pathname },
      ...(document.hidden ? { hidden: true, warning: this.hiddenNote() } : {}),
      ...(reachedTop ? {} : { note: "Stopped before the start of the conversation (time budget). Run the same command again to keep loading older messages." }),
      count: reachedTop || flags.partial ? messages.length : loadedStories,
      complete: reachedTop,
      first: messages.length ? messages[0].iso || messages[0].when : null,
      last: messages.length ? messages[messages.length - 1].iso || messages[messages.length - 1].when : null,
      messages,
    };
  }

  // Per-document cache shared by every instance (each command gets a fresh instance, but
  // the isolated world, and so globalThis, lives as long as the page).
  cache() {
    if (!globalThis.__uwmCache) globalThis.__uwmCache = {};
    return globalThis.__uwmCache;
  }

  // Walk the rooms within the time budget. Finished rooms are cached, so re-running the same
  // command resumes where it stopped; when nothing is left it returns every thread.
  async all(...args) {
    this.requireMessages();
    const { flags } = this.parseArgs(args);
    const started = Date.now();
    const deadline = this.deadlineFor(flags, started);
    const cache = this.cache();
    if (flags.refresh) for (const k of Object.keys(cache)) delete cache[k];
    await this.loadAllRooms();
    let ids = this.roomLinks().map((a) => a.id);
    if (flags.room) {
      const a = this.findRoom(flags.room);
      if (!a) throw new Error('No room matching "' + flags.room + '"');
      ids = [a.id];
    }
    if (flags["limit-rooms"]) ids = ids.slice(0, Number(flags["limit-rooms"]));
    if (!cache.__origin) cache.__origin = this.currentRoomId();
    const returnTo = cache.__origin;
    const sweep = { ...flags, "no-system": false, limit: undefined }; // cache the full thread; filter on output
    for (const id of ids) {
      if (cache[id] && cache[id].complete) continue;
      if (document.hidden) throw new Error(this.hiddenNote());
      if (Date.now() > deadline - 3000) break;
      try {
        await this.openRoom(id);
        const th = await this.readThread(sweep, deadline);
        if (th.complete && !document.hidden) cache[id] = th;
      } catch (e) {
        cache[id] = { room: { id }, complete: true, error: String((e && e.message) || e), count: 0, messages: [] };
      }
    }
    const pending = ids.filter((id) => !(cache[id] && cache[id].complete));
    if (!pending.length) delete cache.__origin;
    if (returnTo && this.currentRoomId() !== returnTo && !pending.length) {
      try {
        await this.openRoom(returnTo);
      } catch (e) {
        /* best effort */
      }
    }
    if (pending.length) {
      return {
        done: false,
        remaining: pending.length,
        loaded: ids.length - pending.length,
        note: "Time budget reached. Run the same command again to continue; results are cached in the page.",
      };
    }
    const threads = ids.map((id) => cache[id]).map((t) => {
      let messages = t.messages;
      if (flags["no-system"]) messages = messages.filter((m) => !m.system);
      if (flags.limit) messages = messages.slice(-Number(flags.limit));
      return { ...t, messages, count: messages.length };
    });
    return { done: true, rooms: threads.length, messages: threads.reduce((n, t) => n + t.messages.length, 0), threads };
  }

  // ------------------------------------------------------------------- find

  matcher(words, flags) {
    const q = words.join(" ").trim();
    if (!q) throw new Error("find: expected search text");
    if (flags.regex) {
      const re = new RegExp(q, "i");
      return { q, test: (s) => re.test(s), index: (s) => s.search(re), len: (s) => (s.match(re) || [""])[0].length };
    }
    const needle = q.toLowerCase();
    return { q, test: (s) => s.toLowerCase().includes(needle), index: (s) => s.toLowerCase().indexOf(needle), len: () => needle.length };
  }

  snippet(text, m) {
    const i = Math.max(0, m.index(text));
    const from = Math.max(0, i - 80);
    const to = Math.min(text.length, i + m.len(text) + 120);
    return (from > 0 ? "…" : "") + text.slice(from, to).replace(/\s+/g, " ") + (to < text.length ? "…" : "");
  }

  searchThread(th, m, flags) {
    const ctxN = flags.context ? Number(flags.context) : 0;
    const since = flags.since || null;
    const until = flags.until ? flags.until + "T23:59" : null;
    const author = flags.author ? String(flags.author).toLowerCase() : null;
    const hits = [];
    th.messages.forEach((msg, i) => {
      if (author && !String(msg.author || "").toLowerCase().includes(author)) return;
      if (since && msg.iso && msg.iso < since) return;
      if (until && msg.iso && msg.iso > until) return;
      const hay = [msg.text, msg.quote || "", ...msg.attachments.map((a) => a.name)].join("\n");
      if (!m.test(hay)) return;
      const hit = {
        room: th.room.name,
        roomId: th.room.id,
        id: msg.id,
        author: msg.author,
        when: msg.when,
        iso: msg.iso,
        snippet: this.snippet(hay, m),
        attachments: msg.attachments.filter((a) => m.test(a.name)).map((a) => a.name),
      };
      if (ctxN) {
        hit.context = th.messages.slice(Math.max(0, i - ctxN), i + ctxN + 1).map((x) => ({ author: x.author, when: x.when, text: x.text }));
      }
      hits.push(hit);
    });
    return hits;
  }

  async find(...args) {
    this.requireMessages();
    const { words, flags } = this.parseArgs(args);
    const m = this.matcher(words, flags);
    const matches = [];
    let rooms = 0;
    if (flags.all) {
      const res = await this.all(...(flags.room ? ["--room", flags.room] : []), ...(flags.budget ? ["--budget", flags.budget] : []), ...(flags.refresh ? ["--refresh"] : []));
      if (!res.done) return { query: m.q, done: false, remaining: res.remaining, loaded: res.loaded, note: res.note.replace("the same command", "the same `find` command") };
      for (const th of res.threads) {
        if (!th.messages) continue;
        rooms += 1;
        matches.push(...this.searchThread(th, m, flags));
      }
    } else {
      const th = await this.thread(...(flags.room ? ["--room", flags.room] : []), ...(flags.budget ? ["--budget", flags.budget] : []));
      if (!th.complete) return { query: m.q, done: false, note: th.note };
      rooms = 1;
      matches.push(...this.searchThread(th, m, flags));
    }
    return { query: m.q, done: true, rooms, count: matches.length, matches };
  }

  async status() {
    return {
      url: location.href,
      isMessages: /\/ab\/messages\//.test(location.pathname),
      signedOut: this.isSignedOut(),
      room: this.currentRoomId(),
      roomName: this.roomTitle(),
      roomsLoaded: this.roomLinks().length,
      storiesInDom: this.stories().length,
    };
  }
}
