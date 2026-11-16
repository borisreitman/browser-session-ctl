# facebook plugin

List and download the photos of a Facebook post. Read-only.

Source: `plugins/facebook.js`. First `plugin.facebook ...` auto-loads it. Point `--tab` at a `facebook.com` tab where you are signed in.

```bash
browser-session-ctl --tab <id> plugin.facebook images
browser-session-ctl --tab <id> plugin.facebook walk
browser-session-ctl --tab <id> plugin.facebook status

# download what `walk` returned with the built-in command
browser-session-ctl --tab <id> images --url <url> --url <url> --save ./out --prefix photo
```

The plugin only finds the image URLs. Saving is the generic `images --url ... --save DIR` command, which fetches the bytes through the extension's service worker with the site's cookies.

A post's grid renders only the first few photos and hides the rest behind a "+N" overlay, so `images` alone is not complete. `walk` opens the large photo viewer on the first photo and clicks "Next photo" until a viewer URL repeats, reading the full-size image each time. In a 19-item post this gave 16 photos (3000 to 4096 px wide) plus 3 videos.

## Methods

| Method | What it does |
| --- | --- |
| `help` | Describe the methods. |
| `images [--min-size N]` | Photos on screen for the post (in a dialog, or in the main column of a `/posts/` or `/permalink` page). Returns `url`, `postId`, `count`, `hidden` (the "+N" overlay) and `images[]`: `index`, `fbid`, `url`, `width`, `height`, `alt`, `photoUrl`. Default `--min-size` is 200. |
| `walk [--max N]` | With a photo viewer open (`/photo/?fbid=...`), step through every item. Returns `count`, `images[]` (`index`, `fbid`, `url`, `width`, `height`, `alt`) and `skipped[]` (`url`, `kind`: `video`, `other` or `photo-not-loaded`). Default `--max` is 100. |
| `status` | URL, post id, and whether a post dialog is open. |

## Typical flow

1. Run `images` on the post. If `hidden` is more than 0, take a `photoUrl` from the result.
2. Navigate a tab to it (`browser-session-ctl --tab <id> nav <photoUrl>`), wait a few seconds, and run `walk`. Start on the first photo, because `walk` only goes forward.
3. Pass each `images[].url` to `images --url ... --save DIR`.

`https://www.facebook.com/media/set/?set=pcb.<postId>&type=1` also lists the post's photos, but it showed 16 of 19 items, so `walk` is the safer source.

## Notes

- Videos are not downloaded. Their `<video>` has an empty `src` (the stream is segmented), so `walk` lists them under `skipped`.
- `walk` advances the tab's own viewer, so use a spare tab, or expect the tab to end on the last item.
- Photo URLs are signed and expire (`oe=`), so download soon after `walk`.
- Facebook interleaves invisible characters into author and post text, so the plugin reads images only and does not extract text.
- The plugin relies on the `Next photo` aria-label and `/photo/?fbid=` links, so a UI change could break `walk`.
