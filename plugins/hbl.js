// @requires bbpress
// Built-in plugin: read a thread on hbletter.com (HBL) as JSON.
//
//   browser-session-ctl --tab <id> plugin.hbl thread > thread.json
//
// HBL is bbPress with a custom "hbl-post-card" theme, so this is the bbpress plugin
// with HBL's selectors. Everything else (DOM -> Markdown, page walking, the
// stop-when-no-new-post rule, status/posts/thread) is inherited. The `// @requires`
// line above makes the CLI bundle plugins/bbpress.js into this plugin's generated file.
//
// HBL specifics: the header card prints the author's email; it is deliberately not
// captured. The topic page's ".bbp-pagination" links describe the forum's topic
// list, not the replies (see bbpress.js), which `thread` already ignores.
class Plugin extends globalThis.__bscPluginExports.bbpress {
  help() {
    const h = super.help();
    return { ...h, namespace: "hbl", note: "bbpress plugin with hbletter.com selectors" };
  }

  selectors() {
    return {
      author: ".hbl-post-card__author",
      date: ".hbl-post-card__date",
      title: ".hbl-post-card__title",
    };
  }

  // The forum a post belongs to, from the "bbp-parent-forum-<id>" class on its card.
  extra(card) {
    const m = String(card.className).match(/\bbbp-parent-forum-(\d+)\b/);
    return m ? { forumId: m[1] } : {};
  }
}
