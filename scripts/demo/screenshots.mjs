// Capture the README screenshots from a running Obsidian (see scripts/demo/README.md).
//
//   node scripts/demo/screenshots.mjs <out-dir>
//
// Everything runs in one DevTools session: the viewport override resets when
// the session closes.

import fs from "fs";
import path from "path";

const PORT = process.env.PORT ?? "9333";
const WIDTH = 1400;
const HEIGHT = 860;
const SCALE = 2;
const out = path.resolve(process.argv[2] ?? "docs/images");
fs.mkdirSync(out, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
let seq = 0;
const waiting = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  waiting.get(msg.id)?.(msg);
  waiting.delete(msg.id);
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    waiting.set(id, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const run = async (fn, ...args) => {
  const r = await send("Runtime.evaluate", {
    expression: `(${fn})(...${JSON.stringify(args)})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const shot = async (name, clip) => {
  const params = { format: "png", captureBeyondViewport: false };
  if (clip) params.clip = { ...clip, scale: 1 };
  const { data } = await send("Page.captureScreenshot", params);
  fs.writeFileSync(path.join(out, name), Buffer.from(data, "base64"));
  console.log(`wrote ${name}`);
};

await send("Emulation.setDeviceMetricsOverride", {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: SCALE,
  mobile: false,
});

// ---- in-page helpers

await run(() => {
  // The real pointer may rest over the window: ignore real hovers so only
  // the scripted ones open bubbles.
  if (!window.__acrDemo) {
    window.__acrDemo = true;
    for (const type of ["mouseover", "mouseout", "mousemove"]) {
      document.addEventListener(type, (e) => e.isTrusted && e.stopImmediatePropagation(), true);
    }
  }
  app.vault.setConfig("showInlineTitle", false);
  app.vault.setConfig("spellcheck", false);
});

const prepare = (theme) =>
  run(async (theme) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    app.setting?.close();
    app.changeTheme(theme);
    const plugin = app.plugins.plugins["agent-change-review"];
    const file = app.vault.getAbstractFileByPath("Study plan.md");
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(file, { state: { mode: "source", source: false } });
    await plugin.openSidebar();
    leaf.view.editor.scrollTo(0, 0);
    // No focused editor: Live Preview would reveal the markup on the cursor line.
    document.activeElement?.blur();
    await wait(800);
  }, theme);

/** Hover the tint containing `text`; returns a clip around tint + bubble. */
const hover = (text) =>
  run(async (text) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await wait(200);
    // A capture can fire a scroll event, which closes the bubble: retry.
    let el = null;
    for (let i = 0; i < 5 && !document.querySelector(".acr-bubble"); i++) {
      el = Array.from(document.querySelectorAll(".acr-ch")).find((e) => e.textContent.includes(text));
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await wait(500);
    }
    const a = el.getBoundingClientRect();
    const b = document.querySelector(".acr-bubble").getBoundingClientRect();
    const pad = 20;
    const x = Math.min(a.left, b.left) - pad;
    const y = Math.min(a.top, b.top) - pad;
    return {
      x,
      y,
      width: Math.max(a.right, b.right) + pad - x,
      height: Math.max(a.bottom, b.bottom) + pad - y,
    };
  }, text);

const rectOf = (selector, pad = 0) =>
  run(
    (selector, pad) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { x: r.left - pad, y: r.top - pad, width: r.width + 2 * pad, height: r.height + 2 * pad };
    },
    selector,
    pad
  );

// ---- shots

for (const theme of ["moonstone", "obsidian"]) {
  const suffix = theme === "moonstone" ? "light" : "dark";
  await prepare(theme);
  await shot(`overview-${suffix}.png`);
  await hover("library");
  await shot(`hover-${suffix}.png`);
}

await prepare("moonstone");
await shot("bubble-sentence.png", await hover("library"));
await shot("bubble-link.png", await hover("2026"));
await shot("bubble-paragraph.png", await hover("Several members"));
await run(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
await shot(
  "sidebar.png",
  await run(() => {
    const view = document.querySelector(".workspace-leaf-content[data-type='agent-change-review-sidebar']");
    const v = view.getBoundingClientRect();
    const list = view.querySelector(".acr-sidebar-list").getBoundingClientRect();
    return { x: v.left, y: v.top, width: v.width, height: list.bottom - v.top + 16 };
  })
);

await run(async () => {
  app.setting.open();
  app.setting.openTabById("agent-change-review");
  await new Promise((r) => setTimeout(r, 500));
});
await shot("settings.png", await rectOf(".modal.mod-settings .vertical-tab-content"));
await run(() => app.setting.close());

await send("Emulation.clearDeviceMetricsOverride");
ws.close();
