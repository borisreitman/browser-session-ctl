# allegiant plugin

Search Allegiant on allegiantair.com in an existing Chrome tab and read the flight list as JSON. Allegiant does not show up on Expedia or eDreams, so this is the way to look at G4 fares.

Source: `plugins/allegiant.js`. First `plugin.allegiant …` auto-loads it.

```bash
browser-session-ctl --tab <id> plugin.allegiant search BLI LAS 2026-10-16 2026-10-29
browser-session-ctl --tab <id> plugin.allegiant results
browser-session-ctl --tab <id> plugin.allegiant day departing 2026-10-17
browser-session-ctl --tab <id> plugin.allegiant select departing 0
```

`search <from> <to> <depart> [return] [adults]` needs a tab on the allegiantair.com homepage (anywhere else it navigates there and asks you to run it again). There is no working search deep link — submit mints a `/booking/<session>/flights?o=…&d=…&ds=…` URL — so the plugin fills the search form (airports, calendar, trip type) and presses **Search**.

| method | what it does |
| --- | --- |
| `results` | departing / returning rows: flight number, times, `period` (morning/afternoon/evening), price, seats; plus the nearby-day tabs |
| `day <departing\|returning> <YYYY-MM-DD>` | click a date tab (Allegiant often flies only a few days a week) |
| `select <departing\|returning> <index\|flight>` | click one row; does not book |
| `close` | optional — every other command already dismisses cookies and the ice-pop before acting |
| `status` | home / results / other |

## Notes

- The plugin sends full pointer/mouse event sequences; Allegiant's react-select and calendar ignore a bare `.click()`.
- Dates with no departure are disabled in the calendar and listed as **No Flights** on the results tabs. That is the airline's schedule, not a plugin failure.
- `period` is from the departure clock: morning before noon, afternoon until 6pm, evening after 6pm.
- Cookie banners and the credit-card ice-pop are dismissed automatically before `search`, `results`, `day`, `select`, and `status` (and again before each click). You do not call `close`. The ice-pop **X** is used, never Apply.
