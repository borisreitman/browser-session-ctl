// Built-in plugin: list the photos of a Facebook post open in this tab.
//
//   browser-session-ctl --tab <id> plugin.facebook images
//   browser-session-ctl --tab <id> plugin.facebook images --min-size 400
//
// Read-only. It reports the photos the page already renders for the signed-in
// user; it does not open the photo viewer or click anything. Facebook puts a
// post either in a dialog (opened from the feed) or in the main column (a
// /posts/<id> or /permalink page); the photos are the <img>s wrapped in a link
// to /photo/?fbid=<id>&set=pcb.<postId>. Avatars, story tiles and sponsored
// images do not link there, so they are skipped. A grid that hides extra
// photos behind a "+N" overlay is reported through `hidden`.
// `walk` covers posts whose grid hides photos behind "+N": open the first photo
// in the viewer and it pages through all of them, reading each large image.
// To download, pass the returned urls to the built-in command:
//   browser-session-ctl images --url <url> --url <url> --save ./out --prefix fb
class Plugin {
  help() {
    return {
      namespace: "facebook",
      methods: {
        help: "Show this message.",
        images:
          "images [--min-size N] — returns {url, postId, count, hidden, images:[{index, fbid, url, width, height, alt, photoUrl}]} for the post on screen; url is the full-size candidate (widest srcset entry, else the displayed src).",
        walk:
          "walk [--max N] — with a photo viewer open (/photo/?fbid=…), reads the large image, clicks \"Next photo\" and repeats until a viewer URL repeats; videos are listed in `skipped`, not downloaded; returns {count, skipped:[{url, kind}], images:[{index, fbid, url, width, height, alt}]} in viewer order. Start it on the first photo (navigate to a photoUrl from `images`).",
        status: "status — url, the post id and whether a post dialog is open.",
      },
    };
  }

  root() {
    return [...document.querySelectorAll("[role=dialog]")].find((d) => d.querySelector("a[href*='/photo']")) || document.querySelector("[role=main]") || document.body;
  }

  postId() {
    const m = location.href.match(/\/posts\/(\d+)|\/permalink\/(\d+)|story_fbid=(\d+)|[?&]set=pcb\.(\d+)/);
    return m ? m[1] || m[2] || m[3] || m[4] : null;
  }

  status() {
    return { url: location.href, postId: this.postId(), dialog: !!document.querySelector("[role=dialog] a[href*='/photo']") };
  }

  best(img) {
    let url = img.currentSrc || img.src;
    let width = img.naturalWidth || 0;
    for (const part of (img.getAttribute("srcset") || "").split(",")) {
      const [u, w] = part.trim().split(/\s+/);
      const n = parseInt(w, 10);
      if (u && n > width) { url = u; width = n; }
    }
    return url;
  }

  images(...args) {
    const flags = {};
    for (let i = 0; i < args.length; i += 1) {
      if (String(args[i]).startsWith("--")) { flags[String(args[i]).slice(2)] = String(args[i + 1] || ""); i += 1; }
    }
    const min = flags["min-size"] ? Number(flags["min-size"]) : 200;
    const root = this.root();
    const postId = this.postId();
    const seen = new Set();
    const images = [];
    for (const img of root.querySelectorAll("img")) {
      const a = img.closest("a[href*='/photo']");
      if (!a) continue;
      const fbid = (a.href.match(/[?&]fbid=(\d+)/) || [])[1];
      const set = (a.href.match(/[?&]set=pcb\.(\d+)/) || [])[1];
      if (postId && set && set !== postId) continue;
      if (Math.max(img.naturalWidth, img.naturalHeight) < min) continue;
      const key = fbid || img.currentSrc;
      if (seen.has(key)) continue;
      seen.add(key);
      images.push({
        index: images.length,
        fbid: fbid || null,
        url: this.best(img),
        width: img.naturalWidth,
        height: img.naturalHeight,
        alt: String(img.alt || "").replace(/\s+/g, " ").trim(),
        photoUrl: a.href.replace(/&__cft__.*$/, ""),
      });
    }
    const overlay = [...root.querySelectorAll("a[href*='/photo'] *")].map((e) => e.children.length === 0 && (e.textContent.match(/^\+\s*(\d+)$/) || [])[1]).find(Boolean);
    return { url: location.href, postId, count: images.length, hidden: overlay ? Number(overlay) : 0, images };
  }

  viewerImage() {
    const fbid = (location.href.match(/[?&]fbid=(\d+)/) || [])[1] || null;
    let best = null;
    for (const img of document.querySelectorAll("img")) {
      if (img.closest("a, button") && !img.closest("a[href*='/photo']")) continue;
      const area = img.naturalWidth * img.naturalHeight;
      if (img.naturalWidth >= 400 && (!best || area > best.naturalWidth * best.naturalHeight)) best = img;
    }
    if (!fbid || !best) return null;
    return {
      fbid,
      url: this.best(best),
      width: best.naturalWidth,
      height: best.naturalHeight,
      alt: String(best.alt || "").replace(/\s+/g, " ").trim(),
    };
  }

  async walk(...args) {
    const i = args.indexOf("--max");
    const max = i >= 0 ? Number(args[i + 1]) : 100;
    const images = [];
    const skipped = [];
    const seen = new Set();
    let prevUrl = null;
    for (let n = 0; n < max; n += 1) {
      const key = location.href.replace(/&__cft__.*$/, "");
      if (seen.has(key)) break;
      seen.add(key);
      if (/[?&]fbid=\d+/.test(key)) {
        const cur = await bsc.waitFor(() => {
          const v = this.viewerImage();
          return v && v.url !== prevUrl ? v : null;
        }, 40, 250);
        if (!cur) { skipped.push({ url: key, kind: "photo-not-loaded" }); } else { prevUrl = cur.url; images.push({ index: images.length, ...cur }); }
      } else {
        skipped.push({ url: key, kind: /\/videos?\/|\/reel\//.test(key) ? "video" : "other" });
      }
      const next = await bsc.waitFor(() => document.querySelector("[aria-label='Next photo']"), 20, 250);
      if (!next) break;
      const before = location.href;
      next.click();
      await bsc.waitFor(() => location.href !== before, 40, 250);
      await bsc.sleep(300);
    }
    return { count: images.length, skipped, images };
  }
}
