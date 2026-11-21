# Google Ads: Keyword Planner

`plugins/google-ads.js` automates **Keyword Planner → Discover new keywords** on ads.google.com. Those methods are read-only: they run searches and read the results, and never save a plan or touch a campaign. Three general helpers (`reveal`, `fill`, `follow`) work on any ads.google.com page; see [General helpers](#general-helpers-for-any-adsgooglecom-page), because `fill` writes.

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

## General helpers for any ads.google.com page

The Keyword Planner methods above are read-only. Three more methods work on any ads.google.com page (campaign wizard, settings, conversions), where plain `snapshot` / `click` / `type` fall short:

```bash
browser-session-ctl plugin.google-ads reveal "Save and continue"                 # scroll it into view
browser-session-ctl plugin.google-ads fill Headline 2 "Supports Anthem Liberty"  # write the 3rd Headline field
browser-session-ctl plugin.google-ads follow "ALF - Shop button click"           # click that <a> link
```

- **`reveal <text>`** scrolls the smallest element containing the text into view, inside whatever nested scroller holds it. The campaign wizard scrolls an inner panel, so plain `scroll` does nothing there, and `snapshot` only lists controls that are on screen: reveal first, then snapshot. It changes nothing but the viewport.
- **`fill <label> <index> <value...>`** **writes**: it sets the Nth (0-based) input or textarea whose placeholder, aria-label or label *starts with* `<label>`, even when it is scrolled off screen (the repeated `Headline` / `Description` fields, the `Enter or paste keywords` box), and **replaces the field's whole value**. There is no read mode: never call it just to look at a field (a loop that did so once overwrote seven headlines with placeholder text). It saves nothing by itself; the page's own Save / Done button still has to be clicked.
- **`follow <text>`** clicks the `<a>` whose text equals `<text>` and returns its `href`. Plain `click <text>` takes the first element containing the text, which on the conversions list is the same-named "Edit this Conversion action" button, not the link.

Things the wizard does that you should expect when scripting it: the Final URL, display paths, headlines, descriptions and keywords of a new ad group are **prefilled from another page or ad group**, so set them all; Google also adds **sitelinks** you did not ask for (remove them); entering keywords in the new-ad-group form did not persist for us, so add them afterwards from the keywords page and check the keyword count; and saving some changes (a budget, for instance) asks you to re-verify your Google sign-in with a "Confirm it's you" dialog, which a person has to complete.

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
