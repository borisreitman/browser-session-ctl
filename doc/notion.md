# notion plugin

Read Notion (`app.notion.com`) from a tab you are driving: search, open a page, read its comments, read its whole body. It drives the same UI a person uses, since Notion has no public JS API to call from the page.

```bash
browser-session-ctl --tab <id> plugin.notion              # help
browser-session-ctl --tab <id> plugin.notion search "INTEG-1565"
browser-session-ctl --tab <id> plugin.notion open "INTEG-1565" --index 0
browser-session-ctl --tab <id> plugin.notion page
browser-session-ctl --tab <id> plugin.notion comments
```

## Methods

| Method | What it does |
|---|---|
| `search <query...>` | Opens "Search or ask" and returns matching pages: `title`, `breadcrumb`, `url`. |
| `open <query...> [--index N]` | Searches, then clicks the Nth result (default 0) to navigate to that page. |
| `results` | Re-reads the results currently showing without changing the query. |
| `close` | Closes the search overlay. |
| `comments` | On the open page (falls back to the inline comments area for layouts with no topbar Comments button, e.g. database rows opened with `?v=`; returns `[]` when there are none), opens the Comments panel and returns every comment as `{thread, author, authorUrl, timestamp, body}`. |
| `closeComments` | Closes the Comments panel. |
| `properties` | Reads the page properties above the body (status fields, AI Summary, relations such as FACT records) as `{fields: [{name, value}]}`. Collapsed groups ("25 more properties") are not opened. |
| `page [--json] [--no-expand]` | Returns the whole body of the open page (see below). |

## `page`

`text` and `snapshot` miss most of a long Notion page, for two reasons:

- **Lazy rendering.** Notion only keeps the blocks near the viewport in the DOM, so everything below the fold is not there. `page` scrolls the page scroller from top to bottom and collects blocks by id as they render, then puts the scroll position back.
- **Collapsed toggles.** The children of a toggle block or toggle heading (for example `### PR 1`) are not rendered while it is closed. By default `page` opens every collapsed toggle, including ones nested inside other toggles, by clicking the arrow (`div[role=button][aria-expanded=false][aria-label=Open]`) until none are left.

Opening toggles changes their open/closed state for your Notion user, and `page` leaves them open. Use `--no-expand` to read the page as it is, collapsed toggles included (their children will be missing).

Returns:

```json
{
  "title": "Page title",
  "url": "https://app.notion.com/p/...",
  "blockCount": 265,
  "toggleClicks": 10,
  "markdown": "# Heading\n\n- item\n  - nested item\n▸ toggle title\n  - child of the toggle\n..."
}
```

`--json` adds `blocks`: `[{id, type, depth, text, checked?}]`, where `type` is Notion's block type (`header`, `sub_header`, `sub_sub_header`, `text`, `bulleted_list`, `numbered_list`, `to_do`, `toggle`, `quote`, `callout`, `code`, `divider`, `image`, `table`, ...) and `depth` is how many blocks it is nested inside.

Markdown mapping: `header`/`sub_header`/`sub_sub_header` become `#`/`##`/`###`, lists become `-` and `1.`, `to_do` becomes `- [ ]` / `- [x]`, toggles get a `▸` prefix, `code` is fenced, images are `[image]`. Nesting is two spaces per level.

## Limits

- Only the text of a block is read. Images, embedded files, database/table cells and linked page previews appear as `[image]`, a bare title, or plain cell text without structure.
- Mentions, dates and links are flattened to their visible text.
- A very long page takes a while: it scrolls in steps and waits for rendering at each step.
- `page` needs an open page. On a database view or with the search overlay open it throws.
