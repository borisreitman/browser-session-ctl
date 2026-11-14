# upwork-messages plugin

Read and search Upwork Messages (`/ab/messages/`) in a tab where you are signed in. Read-only: it never types in the composer, sends, edits, deletes, saves or marks messages.

Source: `plugins/upwork-messages.js`. See [plugins.md](plugins.md). Use `--profile` if several Chrome profiles are connected.

```bash
browser-session-ctl plugin.upwork-messages rooms                 # every conversation
browser-session-ctl plugin.upwork-messages open "Zara"           # switch room (no reload)
browser-session-ctl plugin.upwork-messages thread                # the open room, whole history
browser-session-ctl plugin.upwork-messages thread --room Zara --no-system --limit 50
browser-session-ctl plugin.upwork-messages all > all.json        # every room (resumable)
browser-session-ctl plugin.upwork-messages find invoice --all --context 1
browser-session-ctl plugin.upwork-messages find "android studio" --room Hastree --since 2024-12-01
```

`find` flags: `--all`, `--room X`, `--regex`, `--author A`, `--since YYYY-MM-DD`, `--until YYYY-MM-DD`, `--context N`. It matches message text, quotes and attachment names.

Each message: `id`, `author`, `when` (as Upwork shows it), `iso` (local time, year recovered from the weekday), `text`, `attachments` (`name`, `url`, `size`), `quote`, `system`, `event` (meeting/contract/milestone cards), `edited`, and `approxTime`.

## How it loads history

The message pane is a chat-style reversed scroller: `scrollTop` is `0` at the newest message and goes **negative** going back. Upwork loads 20 messages at a time as you scroll toward the old end, so `thread` scrolls there repeatedly, falling back to a real mouse wheel (`bsc.scrollTrusted`, see the README) when a programmatic scroll stalls.

## Limits

- The sidecar allows ~30s per command. `thread` and `all` work within a time budget (`--budget SECS`, default 12). When a room is not finished they return `complete: false` with progress only (`--partial` returns the loaded messages anyway); run the same command again to continue. `all` caches finished rooms in the page and returns `{done: false, remaining}` until every room is done.
- **Do not trust `complete: true` blindly on very long rooms.** It means several load attempts in a row produced nothing new. On a ~2,000-message room an earlier version stopped hundreds of messages short. Compare `first` with what you expect, and re-run to see whether it moves.
- The tab must be visible (foreground tab in a visible window). A hidden tab loads nothing, and the plugin says so.
- Follow-up messages from the same sender show no time in the DOM; they inherit the previous message's time and are marked `approxTime`.
- Upwork's tooltip has no year; it is inferred as the latest year in which that date falls on that weekday.
