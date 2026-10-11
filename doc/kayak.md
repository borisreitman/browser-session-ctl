# kayak plugin

Search Kayak rental cars in an existing Chrome tab and read the results as structured JSON. Kayak is an aggregator: each car lists the rental agency and every booking site that sells it (Expedia, Priceline, EconomyBookings, DiscoverCars, Booking.com, ...) with that site's total.

Source: `plugins/kayak.js`. First `plugin.kayak ...` auto-loads it. Point `--tab` at a normal `https://` tab; `carsearch` navigates it.

```bash
browser-session-ctl --tab <id> plugin.kayak carsearch LCA 2026-10-22 2026-10-28 23 4 van
browser-session-ctl --tab <id> plugin.kayak carResults 10
browser-session-ctl --tab <id> plugin.kayak status
```

Kayak's results URL carries the whole search, so `carsearch` just builds it and navigates:

```
https://www.kayak.com/cars/LCA/2026-10-22-23h/2026-10-28-4h?sort=price_a&fs=carclass=VAN
```

## Methods

| Method | What it does |
| --- | --- |
| `help` | Describe the methods. |
| `carsearch <place> <pickup> <dropoff> [pickup-hour] [dropoff-hour] [class...]` | Navigate to car results, cheapest first. `place` is an airport code (`LCA` resolves to the airport itself) or a Kayak slug (`Larnaca-LCA`, which resolved to the nearby town of Meneou). Dates `YYYY-MM-DD`. Hours are whole hours 0-23 (default 10); Kayak's `23h30` form did not load. `class` filters by Kayak car class: `van`, `suv`, `small`, `medium`, `large`, `luxury`, `commercial`, `convertible`, `wagon`, `4wd`. |
| `carResults [max]` | Wait for the list; return `count` (Kayak's total), `loaded` (cards in the DOM, lazy) and cars: model, class, seats, bags, doors, agency, pickup, cancellation, rating, total (cheapest offer) and `offers[]` (site and total). |
| `status` | The search this tab shows: place, sort, filter, result count. |

## Notes

- Kayak has no separate minivan class. Its `van` class holds minivans (Opel Zafira, Citroen Grand C4 SpaceTourer, Mazda5) and passenger vans (Nissan Serena, Toyota Sienta); `class` on each car says which.
- The first card is often a paid "Ad" for one site (`ad: true`); `total` there is only that site's price.
- Cars that do not name a model come back with `model: null` and just the class.
- `fs=carclass=VAN` in the URL is what the Car type menu sets, so a search with a class is one navigation.
