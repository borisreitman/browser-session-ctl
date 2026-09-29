# expedia plugin

Search Expedia flights in an existing Chrome tab, then read the offer list as structured JSON. Sort by price, toggle the left-rail departure-time buckets, and click one card.

Source: `plugins/expedia.js`. First `plugin.expedia …` auto-loads it. Point `--tab` at a normal `https://` tab (any page is fine to start; `search` navigates it).

```bash
browser-session-ctl --tab <id> plugin.expedia
browser-session-ctl --tab <id> plugin.expedia search SEA SFO 2026-10-12 2026-10-19
browser-session-ctl --tab <id> plugin.expedia results
```

Expedia's origin/destination widgets are custom typeaheads, not native inputs, so filling the homepage form from a plugin is brittle. `search` instead loads the same **Flights-Search** URL the site uses after you click Search. `results` / `select` then read the rendered cards.

This is not a booking bot. `select` opens the fare panel for one offer; it does not purchase.

## Typical flow

```bash
browser-session-ctl --tab <id> plugin.expedia search YVR TLV 2026-10-15 2026-10-28
browser-session-ctl --tab <id> plugin.expedia sort cheapest
browser-session-ctl --tab <id> plugin.expedia leave evening
browser-session-ctl --tab <id> plugin.expedia results
browser-session-ctl --tab <id> plugin.expedia select 0
```

`search` returns immediately with the URL it is about to load (`location.assign` is deferred so the command can reply). Wait for the results page, then `sort` / `leave` / `results`. `status` tells you whether the tab is still `home`, already `results`, or `other`.

For two nested roundtrips (long-haul plus a side hop), run **two searches**, usually on two tabs — Expedia multi-city is a different product and not what this plugin builds.

## Methods

| Method | What it does |
| --- | --- |
| `help` | Describe the methods. Also the fallback when you omit a method name. |
| `search <from> <to> <depart> [return] [cabin] [adults]` | Navigate to Flights-Search. |
| `sort [cheapest\|recommended\|duration\|latest\|earliest]` | Set **Sort by**. Default: cheapest (`Price: low to high`). |
| `leave <early-morning\|morning\|afternoon\|evening>` | Toggle a **Departure time** checkbox on the left rail (origin local time). Repeat to uncheck. |
| `results` | Wait for offer cards and return them. |
| `select <index>` | Click one offer from the current list (0-based). |
| `status` | `home` / `results` / `other`, plus Leaving from / Going to / Dates / Travelers when those fields are on the page. |

### `search`

Airports are 3-letter IATA codes. Dates are `YYYY-MM-DD` or `MM/DD/YYYY`. Omit the return date (or pass `oneway`) for one-way. Cabin: `economy` (default), `premium`, `business`, `first`. Adults: `1`–`6`. Extra tokens can appear in any order after the depart date.

```bash
browser-session-ctl --tab <id> plugin.expedia search SEA SFO 2026-10-12
browser-session-ctl --tab <id> plugin.expedia search SEA SFO 2026-10-12 2026-10-19 business 2
```

The constructed URL looks like:

```
https://www.expedia.com/Flights-Search?trip=roundtrip&leg1=from:SEA,to:SFO,departure:10/12/2026TANYT&…
```

### `sort`

Aliases: `cheapest` / `price` / `cheap` → Price: low to high; `duration` / `shortest` → Shortest duration; `latest` / `earliest` → Latest / Earliest departure; `recommended`.

Works on a native `<select>` or a labelled combobox. Call it on a results page after offers have rendered.

### `leave`

Expedia's buckets (origin local clock):

| Token | Window |
| --- | --- |
| `early-morning` | before 5:00am |
| `morning` | 5:00am–11:59am |
| `afternoon` | 12:00pm–5:59pm |
| `evening` | 6:00pm–11:59pm |

`night` is accepted as an alias for `evening`. A 5:50pm departure is **afternoon**, not evening — the Evening filter will hide it.

These are checkboxes. Each call toggles one bucket. Combining morning + evening is two `leave` calls.

### `results`

Polls until Select / Cheapest cards appear (a few seconds), then returns `{ url, title, count, filters, flights }`. Each flight includes airline, depart/arrive, price, stops, layover, duration, airports when the card text has them, the raw accessibility label, and `usWorkHours`.

`usWorkHours` is true when the **origin-local** departure is in 9:00am–5:00pm (a typical US workday). It is independent of Expedia's afternoon/evening buckets.

If the tab is not a Flights-Search results page, it tells you to run `search` first.

### `select`

Clicks the same button `results` indexed. The list can change after `sort` or `leave`; run `results` again if you need fresh indexes.

## Limits

- US Expedia (`expedia.com`) results UI. Other locales, hotels, cars, and packages are out of scope.
- Offer parsing depends on the "Select … flight, departing at … Priced at $…" accessibility names. If Expedia changes those labels, `results` will time out or return an empty list.
- Airports Expedia does not sell (for example some Haifa / HFA hops) come back as no matching options — that is the site, not the plugin.
- `search` does not wait for the SPA to finish; `results` does. Sidecar commands themselves still have a timeout, so a very slow results page can fail once — retry `results`.
- Plugin instances die when the page unloads (`search` navigates). That is expected; the next command constructs a new instance on the results document.
