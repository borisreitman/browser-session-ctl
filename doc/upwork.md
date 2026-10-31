# upwork plugin

Search Upwork freelancers (`/nx/search/talent/`) in a tab where you are signed in. Read-only: it never saves, invites or messages anyone.

Source: `plugins/upwork.js`. See [plugins.md](plugins.md). Use `--profile` if several Chrome profiles are connected.

```bash
browser-session-ctl plugin.upwork search go "public relations events" --rate 10-40 --location "United States" --badge top_rated
browser-session-ctl plugin.upwork search results --limit 10
browser-session-ctl plugin.upwork search next
browser-session-ctl plugin.upwork profile open "/freelancers/~01..."
browser-session-ctl plugin.upwork status
```

`search go`, `search next` and `profile open` navigate (the page unloads), so run `search results` / `text` as a separate call afterwards.

Filters: `--rate MIN-MAX` (hourly USD), `--location COUNTRY`, `--badge top_rated|top_rated_plus|rising_talent`, `--page N`.

Each result: `name`, `url`, `title`, `location`, `rate`, `jobSuccess`, `earned`, `available`, `badge`, `boosted`, `relevantJobs`, `skills`, `description`.

Limits:
- Upwork shows only a **country** per freelancer, never a city, so "New York" can't be filtered or checked from search results. Put the city in the keywords at best, or confirm in an interview.
- The `--location` filter is soft: results from other countries can still appear.
- `boosted` results are paid placements, not ranking by fit.
