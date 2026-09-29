// Example plugin: extension/plugins/ or your own file, either works.
//
// Load it as a runtime plugin (no repo changes needed):
//   browser-session-ctl plugin-load hello doc/hello-world-plugin.js
//   browser-session-ctl plugin.hello greet
//   browser-session-ctl plugin.hello greet Boris
//   browser-session-ctl plugin-unload hello
//
// Every plugin file must define a class named exactly `Plugin`. One
// instance is created per namespace on the target tab's own page (world:
// "MAIN"), so `this` is a fine place to keep state between calls, and
// `document`/`window` are the page's own — same as pasting code into that
// tab's DevTools console.
class Plugin {
  constructor() {
    this.calls = 0;
  }

  // Every plugin should implement `help()`: it's what
  // `browser-session-ctl plugin.<namespace>` (no method given) falls back
  // to, so it's the first thing someone reaches for when they've forgotten
  // (or never knew) this plugin's commands.
  help() {
    return {
      namespace: "hello",
      methods: {
        help: "Show this message.",
        greet: "greet [name] — say hello, and count how many times you've called it.",
      },
    };
  }

  // browser-session-ctl plugin.hello greet [name]
  greet(name) {
    this.calls += 1;
    const who = name || "world";
    return {
      message: `Hello, ${who}!`,
      calls: this.calls,
      pageTitle: document.title,
      url: location.href,
    };
  }
}
