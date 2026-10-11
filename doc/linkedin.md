# linkedin plugin

Search LinkedIn people and draft posts as a LinkedIn Page you administer, in a tab where you are already signed in. Nothing is ever published: `post draft` fills the composer and stops, you press **Post** yourself.

Source: `plugins/linkedin.js`. First `plugin.linkedin …` runtime-loads it; later commands inject-load from disk. See [plugins.md](plugins.md). Point `--tab` at a normal `https://www.linkedin.com/` tab (use `--profile` if several Chrome profiles are connected).

Everything is grouped behind subcommands so more areas can be added later:

```bash
browser-session-ctl --tab <id> plugin.linkedin help
browser-session-ctl --tab <id> plugin.linkedin status
browser-session-ctl --tab <id> plugin.linkedin search <url|go|results|next> ...
browser-session-ctl --tab <id> plugin.linkedin page   <list|select|current> ...
browser-session-ctl --tab <id> plugin.linkedin post   <open|draft|status> ...
```

LinkedIn has no page-side JS API and generated class names, so the plugin works from the URL and from stable DOM structure (roles, aria labels, link hrefs). Expect to touch it when LinkedIn restructures a page.

`search go`, `page select` and `post open` navigate, which unloads the page and this plugin instance. They schedule the navigation (so the command can reply) and return immediately. Run the next command as a separate call once the page has loaded.

## People search

| Method | What it does |
| --- | --- |
| `search url <keywords...> [filters]` | Build the people-search URL, without navigating. |
| `search go <keywords...> [filters]` | Navigate this tab to that search. |
| `search results [--limit N]` | Wait for the cards to settle and return them. |
| `search next` | Navigate to the next results page. |
| `status` | URL, whether this is a people search, signed in, page number, result count. |

Filters: `--title T`, `--company C`, `--school S`, `--first F`, `--last L`, `--network 1,2,3` (1st / 2nd / 3rd degree), `--page N`. There is no location filter (LinkedIn needs internal geo ids): put the place in the keywords.

```bash
browser-session-ctl --tab <id> plugin.linkedin search go cto fintech --network 2,3
browser-session-ctl --tab <id> plugin.linkedin search results --limit 5
```

Each person in `results`:

| Field | Meaning |
| --- | --- |
| `name`, `url` | Display name; profile URL without tracking parameters. |
| `degree` | Connection distance: `1st`, `2nd`, `3rd` (from the " • 2nd" badge). |
| `headline`, `location` | The two lines under the name. |
| `mutual` | The "X & Y are mutual connections" line, if shown. |
| `extra` | Any other text lines on the card. |

Out-of-network people have no degree badge and are skipped. If LinkedIn shows a login or verification page, `results` fails with an error instead of returning an empty list.

## Pages and drafting posts

| Method | What it does |
| --- | --- |
| `page list` | Pages you administer, as `{id, name}`, read from the **Me** menu (the plugin opens and closes it). |
| `page select <name-or-id>` | Remember one Page for this tab (`sessionStorage`) and open its admin dashboard. Case-insensitive substring match; errors, listing your pages, if it matches none or several. |
| `page current` | The remembered Page. |
| `post open` | Navigate to the selected Page's composer (`/company/<id>/admin/page-posts/published/?share=true`), which posts as the Page. |
| `post draft <text...>` | Type the text into the open composer, replacing any earlier draft. `\n` starts a new paragraph. Does **not** click Post. |
| `post status` | Whether the composer is open, who it posts as, and its current text. |

`post draft` refuses if the composer's identity ("Anthem Liberty Foundation Post to Anyone") is not the selected Page, so it cannot draft as your personal profile by mistake.

```bash
browser-session-ctl --tab <id> plugin.linkedin page select "anthem liberty"
browser-session-ctl --tab <id> plugin.linkedin post open
browser-session-ctl --tab <id> plugin.linkedin post draft $'First paragraph.\n\nSecond paragraph.'
```

The editor ignores `execCommand("selectAll")`, so the draft is cleared with an explicit selection Range and typed with `insertText` / `insertParagraph`.
