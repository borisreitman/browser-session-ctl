# expedia plugin

Search Expedia flights in an existing Chrome tab, then read the offer list as structured JSON. Sort by price, toggle the left-rail departure-time buckets, and click one card.

Source: `plugins/expedia.js`. First `plugin.expedia …` auto-loads it. Point `--tab` at a normal `https://` tab (any page is fine to start; `search` navigates it).

```bash
browser-session-ctl --tab <id> plugin.expedia
browser-session-ctl --tab <id> plugin.expedia search SEA SFO 2026-10-12 2026-10-19
browser-session-ctl --tab <id> plugin.expedia sort cheapest
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

`search` returns immediately with the URL it is about to load (`location.assign` is deferred so the command can reply). That URL asks Expedia for **Price: low to high**. Wait for the results page, then `sort cheapest` (Expedia often still shows Recommended — do this unless you want a different order), then `leave` / `results`. `sort` is the only method that changes **Sort by**; `results` only reads the list in that order. `status` tells you whether the tab is still `home`, already `results`, or `other`.

Expedia will sometimes cover the list with **Please refresh your search for the latest prices**. Do not read or click cards while that dialog is up — the prices behind it are stale. The plugin clicks **Refresh search** itself: `refresh` does only that; `results`, `sort`, `leave`, `select`, and `status` do it before they touch the list.

For two nested roundtrips (long-haul plus a side hop), run **two searches**, usually on two tabs — Expedia multi-city is a different product and not what this plugin builds.

## Methods

| Method | What it does |
| --- | --- |
| `help` | Describe the methods. Also the fallback when you omit a method name. |
| `search <from> <to> <depart> [return] [cabin] [adults]` | Navigate to Flights-Search, cheapest first (`sortType=PRICE`). |
| `sort [cheapest\|expensive\|recommended\|duration\|longest\|earliest\|latest\|earliest-arrival\|latest-arrival]` | Set **Sort by**. Default: cheapest (`Price: low to high`). Clicks **Refresh search** first if that dialog is up. |
| `leave <early-morning\|morning\|afternoon\|evening>` | Toggle a **Departure time** checkbox on the left rail (origin local time). Repeat to uncheck. Clicks **Refresh search** first if that dialog is up. |
| `refresh` | Click **Refresh search** on Expedia's stale-price overlay. No-op if it is not showing. |
| `results` | Wait for offer cards and return them in the current **Sort by** order. Does not change sort. Clicks **Refresh search** first if that dialog is up. |
| `select <index>` | Click one offer from the current list (0-based). Clicks **Refresh search** first if that dialog is up. |
| `status` | `home` / `results` / `other`, plus Leaving from / Going to / Dates / Travelers when those fields are on the page. Clicks **Refresh search** first if that dialog is up. |

### `search`

Airports are 3-letter IATA codes. Dates are `YYYY-MM-DD` or `MM/DD/YYYY`. Omit the return date (or pass `oneway`) for one-way. Cabin: `economy` (default), `premium`, `business`, `first`. Adults: `1`–`6`. Extra tokens can appear in any order after the depart date.

```bash
browser-session-ctl --tab <id> plugin.expedia search SEA SFO 2026-10-12
browser-session-ctl --tab <id> plugin.expedia search SEA SFO 2026-10-12 2026-10-19 business 2
```

The constructed URL asks for cheapest first (`sortType=PRICE&sortOrder=INCREASING`). Expedia may still open on Recommended — `sort cheapest` after the page loads is the default next step.

```
https://www.expedia.com/Flights-Search?trip=roundtrip&leg1=from:SEA,to:SFO,departure:10/12/2026TANYT&…&sortType=PRICE&sortOrder=INCREASING
```

### `sort`

Expedia's **Sort by** options, with the tokens this plugin accepts:

| Token | Expedia label |
| --- | --- |
| `cheapest` (default), `price`, `cheap` | Price: low to high |
| `expensive`, `high-to-low` | Price: high to low |
| `recommended` | Recommended |
| `duration`, `shortest` | Shortest duration |
| `longest` | Longest duration |
| `earliest` | Earliest departure |
| `latest` | Latest departure |
| `earliest-arrival` | Earliest arrival |
| `latest-arrival` | Latest arrival |

```bash
browser-session-ctl --tab <id> plugin.expedia sort cheapest
browser-session-ctl --tab <id> plugin.expedia sort earliest
browser-session-ctl --tab <id> plugin.expedia results
```

Works on a native `<select>` or a labelled combobox. Call it on a results page after offers have rendered. `results` and `select` do not change sort — they use whatever order is on the page. For a departure-time window, use `leave`; that filters, it does not reorder.

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

### `refresh`

Clicks **Refresh search** on the stale-price dialog and waits until it is gone. Returns `{ refreshed: true }` if it clicked, `{ refreshed: false }` if the overlay was not showing. Use this when you only need to clear the dialog; every other results method already calls it.

### `results`

Polls until Select / Cheapest cards appear (a few seconds), then returns `{ url, title, count, sort, filters, flights }` in the page's current **Sort by** order. `sort` is the control's current label, or `null` if it is not on the page. Each flight includes airline, depart/arrive, price, stops, layover, duration, airports when the card text has them, the raw accessibility label, and `usWorkHours`. If the stale-price dialog was up, it clicks **Refresh search** first and sets `refreshed: true`.

`usWorkHours` is true when the **origin-local** departure is in 9:00am–5:00pm (a typical US workday). It is independent of Expedia's afternoon/evening buckets.

If the tab is not a Flights-Search results page, it tells you to run `search` first. If the overlay is still up after the click, it errors instead of returning the hidden list.

### `select`

Clicks the same button `results` indexed, then **Select Economy Light** (or Continue) if the fare sheet opens, and waits for **Returning flights** on a roundtrip. The list can change after `sort` or `leave`; run `results` again if you need fresh indexes.

## Limits

- US Expedia (`expedia.com`) results UI. Other locales, hotels, cars, and packages are out of scope.
- Offer parsing depends on the "Select … flight, departing at … Priced at $…" accessibility names. If Expedia changes those labels, `results` will time out or return an empty list.
- Airports Expedia does not sell (for example some Haifa / HFA hops) come back as no matching options — that is the site, not the plugin.
- `search` does not wait for the SPA to finish; `results` does. Sidecar commands themselves still have a timeout, so a very slow results page can fail once — retry `results`.
- Plugin instances die when the page unloads (`search` navigates). That is expected; the next command constructs a new instance on the results document.
