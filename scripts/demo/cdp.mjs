// Minimal Chrome DevTools Protocol client for driving Obsidian
// (started with --remote-debugging-port=<port>).
//
//   node scripts/demo/cdp.mjs eval '<js expression>'     run in the app window
//   node scripts/demo/cdp.mjs shot <out.png> [x y w h]   capture (CSS px)
//   node scripts/demo/cdp.mjs size <width> <height>      set the viewport size
//
// PORT defaults to 9333.

import fs from "fs";

const PORT = process.env.PORT ?? "9333";

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools"));
  if (!page) throw new Error("no Obsidian window found");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id;
      waiting.set(n, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return { send, close: () => ws.close() };
}

async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

const [cmd, ...args] = process.argv.slice(2);
const cdp = await connect();
try {
  if (cmd === "eval") {
    const value = await evaluate(cdp, args.join(" "));
    if (value !== undefined) console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  } else if (cmd === "shot") {
    const [out, x, y, w, h] = args;
    const params = { format: "png", captureBeyondViewport: false };
    if (h !== undefined) params.clip = { x: +x, y: +y, width: +w, height: +h, scale: 1 };
    const { data } = await cdp.send("Page.captureScreenshot", params);
    fs.writeFileSync(out, Buffer.from(data, "base64"));
    console.log(`wrote ${out}`);
  } else if (cmd === "size") {
    const [width, height] = args.map(Number);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
  } else {
    console.error("usage: cdp.mjs eval <js> | shot <out.png> [x y w h] | size <w> <h>");
    process.exitCode = 1;
  }
} finally {
  cdp.close();
}
