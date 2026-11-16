# hbl plugin

Read a thread on hbletter.com (HBL) as JSON. Read-only. HBL is bbPress with a custom `hbl-post-card` theme, so `plugins/hbl.js` is the [bbpress plugin](bbpress.md) with HBL's selectors; every method is inherited.

Source: `plugins/hbl.js` (`// @requires bbpress`). Point `--tab` at an HBL thread where you are signed in.

```bash
browser-session-ctl --tab <id> plugin.hbl thread > thread.json
browser-session-ctl --tab <id> plugin.hbl posts
browser-session-ctl --tab <id> plugin.hbl status
```

Methods and the result shape are those of bbpress (`thread`, `posts`, `status`, `help`), plus `forumId` on every post (from the `bbp-parent-forum-<id>` class).

## HBL specifics

- Selectors: author `.hbl-post-card__author`, date `.hbl-post-card__date`, topic title `.hbl-post-card__title`.
- The card header prints each author's email. It is not captured.
- The `.bbp-pagination` links on a topic page describe the forum's topic list (143 pages), not the replies; `thread` ignores them and stops at the first page that adds no new post. On a one-page thread `/page/2/` repeats page 1.
- Use `plugin.bbpress` on other bbPress sites; on HBL it returns empty `author` and `date`.
