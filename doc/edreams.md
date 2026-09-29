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

eDreams covers the page with a consent dialog. Every method that reads or clicks the page dismisses it first by clicking **Continue without agreeing** — it never clicks *Agree & Close*. `close` does only that.

## Notes

- `results` returns the cards eDreams has rendered so far (often 5), not the full "N of 1000 flights match" count; `matching` reports that total.
- `price` is the regular fare; `primePrice` is the Prime-member price when shown.
- Filters and sort reset when the page reloads (including a new `search`).
