# ryanair plugin

Search Ryanair in an existing Chrome tab and read the outbound / return cards as structured JSON. Pick a nearby day, change sort, and click **Select** (Basic if a fare sheet opens). This is not a booking bot.

Source: `plugins/ryanair.js`. First `plugin.ryanair …` runtime-loads it; later commands inject-load from disk. See [plugins.md](plugins.md). Point `--tab` at a normal `https://` tab (`search` navigates it).

```bash
browser-session-ctl --tab <id> plugin.ryanair
browser-session-ctl --tab <id> plugin.ryanair search STN BGY 2026-10-20 2026-10-27
browser-session-ctl --tab <id> plugin.ryanair results
browser-session-ctl --tab <id> plugin.ryanair select outbound 0
```

Ryanair's homepage search pod is a custom widget. `search` loads the same `/trip/flights/select?originIata=…&destinationIata=…&dateOut=…` URL the site uses after you click Search.

## Methods

| Method | What it does |
| --- | --- |
| `help` | Describe the methods. |
| `search <from> <to> <depart> [return] [adults]` | Navigate to flight select. |
| `sort [cheapest\|earliest\|latest\|regular]` | Open **Sort flights by**. Default: cheapest. |
| `day <outbound\|return> <YYYY-MM-DD>` | Click a date tab on that leg. |
| `results` | Wait for cards and return outbound / inbound lists. Does not change sort. |
| `select <outbound\|return> <index\|FR…>` | Click **Select**. Then **Basic** if a fare sheet is showing. |
| `close` | Cookie banner: **No, thanks** (never **Yes, I agree**). Other methods do this first. |
| `status` | `home` / `results` / `other`, plus URL params and counts. |

### `search`

Airports are 3-letter IATA codes. Dates are `YYYY-MM-DD` or `MM/DD/YYYY`. Omit the return date (or pass `oneway`) for one-way. Adults: `1`–`9`.

```bash
browser-session-ctl --tab <id> plugin.ryanair search STN BGY 2026-10-20
browser-session-ctl --tab <id> plugin.ryanair search STN DUB 2026-10-20 2026-10-27 2
```

`search` returns immediately with the URL (`location.assign` is deferred so the command can reply). Wait for the select page, then `results`.

Ryanair only sells its own (and Malta Air / Buzz / Lauda) metal. A route it does not fly shows an empty list — that is the network, not a plugin failure.

## Notes

- Cookie banner is dismissed with **No, thanks**.
- Cards are `flight-card` elements (with a class / Select-button fallback). `flight` is `FR2738`; `operatedBy` is set when the card says Operated by Malta Air (etc.).
- Date tabs look like `20Oct Tuesday £ 33 . 19`. `day` clicks the matching tab on the outbound or return carousel.
- `select` does not purchase.
