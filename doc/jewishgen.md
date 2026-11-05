# jewishgen plugin

Search JewishGen's Global (Unified) Search (`/search/Global_Search.php`) in a Chrome tab. Read-only: it only fills and submits the public search form and reads the results page. It never types credentials.

Source: `plugins/jewishgen.js`. See [plugins.md](plugins.md). Use `--profile` if several Chrome profiles are connected.

```bash
browser-session-ctl plugin.jewishgen regions
browser-session-ctl plugin.jewishgen search go --surname Zajac --town Lwow --region ukraine
browser-session-ctl plugin.jewishgen search results
browser-session-ctl plugin.jewishgen status
```

`search go` submits the form (the page unloads), so run `search results` as a separate call afterwards. If the tab is not on the search page, `search go` navigates there first and you run it again.

Flags for `search go`: `--surname`, `--given`, `--town`, `--any` (at most two; rows 3 and 4 of the form are locked without an account), `--match phonetic|sounds|starts|contains|exact|fuzzy|fuzzier|fuzziest` (default phonetic), `--region` (a code or name from `regions`, for example `ukraine`, `poland`, `israel`, `holocaust`, `usa`).

## Sign-in limit

Logged out, the results page shows "Log in to see results" and no record counts or rows. `search results` then returns `needsLogin: true` plus the partner links (JRI-Poland, Gesher Galicia, Shapell Roster), which are public and work without an account. Sign in to JewishGen yourself in the tab, then search again. The signed-in rows are returned as raw table rows because their markup has not been inspected yet: refine `results()` in the plugin once you have seen real output.

## Notes

- Phonetic matching is the default because spellings vary widely in historical records (Zajac / Zayats / Zaiats, Reitman / Rejtman).
- Towns use the historical name: Lwow (Polish), Lemberg (German), Lviv (Ukrainian).
