# bbpress plugin

Read a bbPress forum thread (topic plus every reply) as JSON. Read-only. It targets stock bbPress markup (`.bbp-topic-content` / `.bbp-reply-content` inside `.type-topic` / `.type-reply`). A themed site subclasses it: override `selectors()` (author, date, title) and optionally `extra(card, head, doc)` for more fields. [hbl](hbl.md) is the worked example.

Source: `plugins/bbpress.js`. First `plugin.bbpress ...` auto-loads it. Point `--tab` at a thread tab where you are signed in.

```bash
browser-session-ctl --tab <id> plugin.bbpress thread > thread.json
browser-session-ctl --tab <id> plugin.bbpress posts
browser-session-ctl --tab <id> plugin.bbpress status
```

## Methods

| Method | What it does |
| --- | --- |
| `help` | Describe the methods. |
| `status` | URL, thread base URL, title and how many posts this page shows. |
| `posts` | Posts rendered on this page only: `{title, url, count, posts[]}`. |
| `thread [--max-pages N] [--delay MS]` | The whole thread. Defaults: 200 pages, 400 ms between fetches. |

`thread` returns one JSON object:

```
{title, url, pages, count, posts: [{seq, id, kind, author, date, iso, permalink, page, markdown}]}
```

- `kind` is `topic` or `reply`; `seq` runs in thread order starting at 1.
- `markdown` is the post body converted from HTML (quotes, links, lists, code, images kept; smileys become their text).
- `date` is the site's own text; `iso` is `YYYY-MM-DD HH:MM` in site-local time (no zone), or `null` if unparsed.

## Pagination

Do not trust the `.bbp-pagination` links on an HBL topic page: they describe the forum's topic list (143 pages), not the replies. On a one-page thread, `/page/2/` answers 200 with the same replies as page 1. So `thread` fetches page 1, 2, 3, ... from the thread's base URL (same origin, your cookies) and stops at the first page that adds no new post id. Only a one-page thread has been tested.

## Notes

- Nothing is written to disk. Split the JSON into files with whatever tool you like.
- Author emails that HBL prints in the card header are deliberately not captured.
- Like/quote buttons, admin links and print widgets are stripped from the body.
