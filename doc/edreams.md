# edreams plugin

Search eDreams flights in an existing Chrome tab, then read the offers as structured JSON. eDreams sells easyJet (`U2`, `EC`) alongside Ryanair, Wizz, Vueling and others, so this is also the way to look at easyJet fares — easyjet.com's own search is a bot-guarded SPA with no usable deep link.

Source: `plugins/edreams.js`. First `plugin.edreams …` auto-loads it.

```bash
browser-session-ctl --tab <id> plugin.edreams
browser-session-ctl --tab <id> plugin.edreams search LGW BCN 2026-10-12 2026-10-19
browser-session-ctl --tab <id> plugin.edreams airline only easyjet
browser-session-ctl --tab <id> plugin.edreams sort cheapest
browser-session-ctl --tab <id> plugin.edreams results
```

`search <from> <to> <depart> [return] [adults]` loads the results URL eDreams itself uses (`/travel/#results/type=R;dep=…;from=…`), like the expedia plugin, rather than filling the typeahead form.

| method | what it does |
| --- | --- |
| `sort [cheapest\|best\|fastest]` | click a sort tab (default cheapest) |
| `airlines` | list the airline filter (code, name, checked) |
| `airline <code\|name>` | toggle an airline; every airline starts checked, so this *unchecks* it |
| `airline only <code\|name>` | keep just that airline, e.g. `airline only easyjet` (U2 + EC) |
| `direct` | toggle "Direct flights" |
| `results` | read the itinerary cards in the current sort order |
| `select <index>` | click one itinerary's fare button; does not purchase |
| `close` | dismiss the cookie modal |
| `status` | home / results / other, sort, counts |

## Cookie modal

eDreams covers the page with a consent dialog and sometimes a Prime **"I understand"** overlay that hides the itinerary list. Every method that reads or clicks the page dismisses those first by clicking **Continue without agreeing** / **I understand** — it never clicks *Agree & Close*. `close` does only that.

`results` / `sort` used to hang until the 30s sidecar timeout: they re-scanned every button on the page on each poll. They now dismiss overlays once, then wait for cards (including rows nested inside `[data-testid=itinerary-list]` when the per-card test id is missing). The list is virtualized — the "N of M flights match" counter can show (even `0 of M`) before any card is painted — so they scroll the list into view and wait up to ~22s for `[data-testid=itinerary]` instead of treating an empty counter as "no flights". If the tab is in the background Chrome may still not paint the rows; bring it to the front and run `results` again.

Captured DOM fixtures live in `tests/fixtures/edreams-*.html` (nested itinerary cards from a live LGW–LCA results page, a deferred paint that starts at `0 of N`, and a finished empty search). `npm test` drives them through the plugin.

## Notes

- `results` returns the cards eDreams has rendered so far (often 5), not the full "N of 1000 flights match" count; `matching` reports that total.
- `price` is the regular fare. `prime` is true when the card shows a Prime fare; `primePrice` is that member price.
- Filters and sort reset when the page reloads (including a new `search`).
