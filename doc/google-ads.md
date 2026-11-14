# Google Ads: Keyword Planner

`plugins/google-ads.js` automates **Keyword Planner → Discover new keywords** on ads.google.com. It is read-only: it runs searches and reads the results, and never saves a plan or touches a campaign.

```bash
browser-session-ctl --profile ads plugin.google-ads search "trail running shoes, hoka"
browser-session-ctl --profile ads plugin.google-ads search "shoes" --site=https://example.com
browser-session-ctl --profile ads plugin.google-ads status
browser-session-ctl --profile ads plugin.google-ads results 100   # current page, as records
browser-session-ctl --profile ads plugin.google-ads all 500       # walk the pages
browser-session-ctl --profile ads plugin.google-ads next          # prev | first | last
browser-session-ctl --profile ads plugin.google-ads sort "Avg. monthly searches"
```

The tab must already be signed in to the right Google Ads account and be on any Keyword Planner screen (Tools → Planning → Keyword Planner). `search` works from the start screen or from an earlier results page, and dismisses the feature-tour dialogs that sit on top of the page.

A row looks like:

```json
{ "keyword": "hoka shoes", "section": "Keyword ideas", "avgMonthlySearches": "100K – 1M",
  "searchesMin": 100000, "searchesMax": 1000000, "threeMonthChange": "0%", "yoyChange": "0%",
  "competition": "High", "adImpressionShare": "—", "bidLow": 0.34, "bidHigh": 2.94 }
```

Volumes are ranges, not counts: an account without ad spend only gets Google's coarse buckets.

## How the site is built

ads.google.com is **AngularDart**, not React: `ng-app` on the root, `_ngcontent-*` as *class names*, `ess-*` and `material-*` components, `angularDart*` globals, no `ng-version`, no `__ngContext__`, and no `ng` debug global. So the plugin drives plain DOM events (`bsc.fireClick`, `bsc.fill`, `bsc.press`).

What it does use is Angular's **testability registry** (`window.ngTestabilityRegistries`, three testabilities here). `bsc.angular.whenStable()` waits until all of them report `isStable()`, so each step waits for the framework rather than a fixed sleep. `extension/angular-probe.js` (page world, injected on demand like the React probe) exposes it, plus discovery helpers:

```bash
browser-session-ctl angular detect        # kind: ivy | angularjs | dart, version, hooks present
browser-session-ctl angular testability   # registries, methods, stable/pending per testability
browser-session-ctl angular whenStable    # wait for the app to settle
browser-session-ctl angular globals       # globals the page defined (framework-ish ones listed)
browser-session-ctl angular survey        # expando properties on DOM nodes
```

`detect` tells the three Angulars apart because their hooks differ (`ng.getComponent` for Ivy, `angular.element().scope()` for AngularJS); `component` uses whichever exists and reports `via: null` for AngularDart.

## Quirks worth knowing

- **`bsc.click` clicks twice** (a synthetic `click`, then `el.click()`). That is harmless for most controls but made the pager skip a page, so this plugin uses `bsc.fireClick`.
- **The results table is virtualized.** Only about 10 of a page's 100 rows are in the DOM at once. `results` and `all` scroll the page shell (`.awsm-nav-bar-and-content`) and collect rows as they render. The "Keywords you provided" / "Keyword ideas" group headers scroll away too, so the group is carried forward.
- **Sort is sticky.** The sort you last chose persists into the next search.
- **The submit button is "Get results".** A `material-button` whose text is "search" is the top-bar global search.
