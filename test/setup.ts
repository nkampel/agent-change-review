// jsdom has no layout: give CodeMirror the measuring APIs it calls.
const empty = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
const rect = () => new DOMRect(0, 0, 0, 0);
Range.prototype.getClientRects ??= empty;
Range.prototype.getBoundingClientRect ??= rect;

// Obsidian's global DOM helpers, as far as the plugin code uses them.
type ElInfo = { cls?: string; text?: string; attr?: Record<string, string> };
(globalThis as unknown as { createSpan: (o?: ElInfo) => HTMLSpanElement }).createSpan ??= (o: ElInfo = {}) => {
  const el = document.createElement("span");
  if (o.cls) el.className = o.cls;
  if (o.text !== undefined) el.textContent = o.text;
  for (const [k, v] of Object.entries(o.attr ?? {})) el.setAttribute(k, v);
  return el;
};

(globalThis as unknown as { activeDocument: Document }).activeDocument ??= document;
// Obsidian's cross-window `instanceof`.
(Node.prototype as unknown as { instanceOf: (type: unknown) => boolean }).instanceOf ??= function (
  this: Node,
  type: unknown
) {
  return this instanceof (type as new () => Node);
};
