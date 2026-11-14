# google-flights plugin

Search Google Flights in an existing Chrome tab, then read the departing-flight cards as structured JSON. Sort by cheapest / best / fastest, expand the list, and click one offer.

Source: `plugins/google-flights.js`. First `plugin.google-flights …` runtime-loads it, then every command inject-loads from disk (edit the plugin and re-run; no extension reload). See [plugins.md](plugins.md). Point `--tab` at a normal `https://` tab (any page is fine to start; `search` navigates it).

```bash
browser-session-ctl --tab <id> plugin.google-flights
browser-session-ctl --tab <id> plugin.google-flights search YVR LCA 2026-10-16 2026-10-29
browser-session-ctl --tab <id> plugin.google-flights sort cheapest
browser-session-ctl --tab <id> plugin.google-flights results
```

Google's origin/destination widgets are custom typeaheads, so filling the homepage form from a plugin is brittle. `search` instead loads the same natural-language **Flights** URL Google uses after you type a query (`/travel/flights?q=Flights from YVR to LCA on … through …`). `results` / `select` then read the rendered cards.

This is not a booking bot. `select` opens the next stage (usually returning flights); it does not purchase.

## Typical flow

```bash
browser-session-ctl --tab <id> plugin.google-flights search YVR Cyprus 2026-10-16 2026-10-29
browser-session-ctl --tab <id> plugin.google-flights sort cheapest
browser-session-ctl --tab <id> plugin.google-flights results
browser-session-ctl --tab <id> plugin.google-flights select 0
```

`search` returns immediately with the URL it is about to load (`location.assign` is deferred so the command can reply). Wait for the results page, then `sort cheapest` (Google opens on **Best**), then `results`. `sort` is the only method that changes the tab order; `results` only reads the list.

A country name such as **Cyprus** is an alias for Larnaca (`LCA`). Searching the country itself lands on Google's Explore map with flexible dates, not a flight list.

## Methods

| Method | What it does |
| --- | --- |
| `help` | Describe the methods. Also the fallback when you omit a method name. |
| `search <from> <to> <depart> [return] [cabin] [adults]` | Navigate to Flights results. |
| `sort [cheapest\|best\|fastest]` | Click a sort tab. Default: cheapest. |
| `results` | Wait for offer cards and return them in the current sort order. Does not change sort. |
| `select <index\|text>` | Click one offer (0-based index, or words matched against the label). |
| `more [max]` | Click **View more flights** until the list stops growing (default up to 5 clicks). |
| `stops [any\|nonstop\|1\|2]` | Set the Stops filter. Default: nonstop. |
| `close` | Dismiss cookie consent and the Track prices dialog. |
| `status` | `home` / `results` / `returning` / `explore` / `other`, plus sort and counts. |

### `search`

Airports are 3-letter IATA codes. Place names (Larnaca, London) work too. Dates are `YYYY-MM-DD` or `MM/DD/YYYY`. Omit the return date (or pass `oneway`) for one-way. Cabin: `economy` (default), `premium`, `business`, `first`. Adults: `1`–`9`. Extra tokens can appear in any order after the depart date.

```bash
browser-session-ctl --tab <id> plugin.google-flights search YVR LCA 2026-10-16
browser-session-ctl --tab <id> plugin.google-flights search YVR LCA 2026-10-16 2026-10-29 business 2
```

Country aliases that would otherwise open Explore:

| Token | Airport |
| --- | --- |
| `Cyprus`, `Larnaca` | `LCA` |
| `Paphos` | `PFO` |

### `sort`

| Token | Google tab |
| --- | --- |
| `cheapest` (default), `price`, `cheap` | Cheapest |
| `best` | Best |
| `fastest`, `fast`, `duration` | Fastest |

```bash
browser-session-ctl --tab <id> plugin.google-flights sort cheapest
browser-session-ctl --tab <id> plugin.google-flights results
```

### `results`

Polls until **From N US dollars…** offer links appear (a few seconds), then returns `{ url, title, kind, count, sort, flights }`. Each flight includes airline, depart/arrive, price, stops, duration, airports when the card text has them, the raw accessibility label, and `usWorkHours`.

`usWorkHours` is true when the **origin-local** departure is in 9:00am–5:00pm (a typical US workday).

If the tab is still Explore (a country without an alias), `results` returns `{ kind: "explore", destinations }` instead. `select` then clicks a city card.

## Limits

- Google Flights (`google.com/travel/flights`) results UI. Hotels and vacation rentals are out of scope.
- Plugins run in the extension content script (page DOM). Google's own JS world blocks `eval`; that does not apply here. Load `google-flights` once and it is available on this tab and any later tab.
- Offer parsing depends on "From N US dollars round trip total. … flight with … Leaves …" accessibility names. If Google changes those labels, `results` will time out or return an empty list.
- `search` does not wait for the SPA to finish; `results` does. Sidecar commands themselves still have a timeout, so a very slow results page can fail once — retry `results`.
- Plugin *instances* die when the page unloads (`search` navigates). The next command builds a new instance from the already-loaded source.
