// Test plugin for the `bsc` API that every plugin gets (see doc/plugins.md).
// Run against react-app.html, and against a plain page for the error cases.
class Plugin {
  el(sel) {
    return document.querySelector(sel);
  }

  async react() {
    const out = {};
    out.isReact = await bsc.isReact();
    out.fill = await bsc.reactFill(this.el("#bio"), "from plugin");
    out.check = await bsc.reactClick(this.el("#subscribe"));
    out.select = await bsc.reactSelect(this.el("#color"), "red");
    out.press = await bsc.reactPress(this.el("#q"), "Enter");
    out.inner = await bsc.reactClick(this.el("#inner"));
    try {
      await bsc.reactClick(this.el("#locked"));
    } catch (err) {
      out.disabled = err.message;
    }
    try {
      await bsc.reactClick(this.el("h1"));
    } catch (err) {
      out.noHandler = err.message;
    }
    out.controls = (await bsc.react.controls()).length;
    out.inspect = await bsc.react.inspect("Counter");
    out.viaCall = await bsc.react.call("isReact");
    out.snapshot = (await bsc.snapshot()).elements.length;
    out.text = (await bsc.text()).text.includes("React Fixture");
    try {
      await bsc.command("tabs.close", {});
    } catch (err) {
      out.blocked = err.message;
    }
    return out;
  }

  // Plain DOM-event variants on the same React page: they work, but they do not
  // go through React's handler objects.
  async native() {
    const out = {};
    bsc.fill(this.el("#plain"), "native fill");
    bsc.fill(this.el("#bio"), "native typing", { clear: true, typing: true });
    bsc.click(this.el("#inc"));
    out.selected = bsc.select(this.el("#color"), "gre", { partial: true });
    bsc.press(this.el("#q"), "ArrowDown");
    out.displayed = [bsc.isDisplayed(this.el("#inc")), bsc.isDisplayed(this.el("#ghost"))];
    out.waited = await bsc.waitFor(() => this.el("#count"), 3, 10);
    out.waitedNone = await bsc.waitFor(() => this.el("#nope"), 2, 5);
    out.date = [bsc.dates.looksLikeDate("2026-10-20"), bsc.dates.toIso("10/5/2026"), bsc.dates.parse("2026-1-2")];
    out.clean = bsc.clean("  a \n b  ");
    return out;
  }

  // On a page that is not React the React variants must refuse.
  async refuse() {
    try {
      await bsc.reactClick(document.querySelector("button, input, a, body"));
    } catch (err) {
      return { error: err.message };
    }
    return { error: null };
  }
}
