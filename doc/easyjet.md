# easyjet plugin

Search easyjet.com in an existing Chrome tab and read the flight tiles as JSON.

Source: `plugins/easyjet.js`. First `plugin.easyjet …` auto-loads it.

```bash
browser-session-ctl --tab <id> plugin.easyjet search LGW BCN 2026-10-17 2026-10-29
browser-session-ctl --tab <id> plugin.easyjet results
browser-session-ctl --tab <id> plugin.easyjet select outbound 2
```

`search <from> <to> <depart> [return] [adults]` needs a tab on the easyjet.com/en homepage (anywhere else it navigates there and asks you to run it again). easyjet.com has no working search deep link, so it fills the search pod (airports, calendar, passengers) and presses **Show flights**.

| method | what it does |
| --- | --- |
| `results` | flight tiles per leg (`outbound` / `return`): date, departure, arrival, price, seats left |
| `select <outbound\|return> <index>` | click one tile; does not book |
| `status` | home / results / other, plus the form values |

## Partner routes

Routes easyJet does not fly itself (e.g. LGW→TLV) hand off to *Connections by easyJet* at `flightconnections.easyjet.com`. `search` catches the popup and loads it in your tab (`via: "connections"`). That site's CSP blocks plugins, so read it with the built-in `text` and `click` commands; click **Reject all** on its cookie modal. City codes such as `LON`/`TELA` do not work there; use airport codes.

## Notes

- The plugin sends full pointer/mouse event sequences; easyJet's widgets ignore a bare `.click()`.
- `results` covers the days easyJet shows around your date, not the whole month.
