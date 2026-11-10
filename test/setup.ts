// jsdom has no layout: give CodeMirror the measuring APIs it calls.
const empty = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
const rect = () => new DOMRect(0, 0, 0, 0);
Range.prototype.getClientRects ??= empty;
Range.prototype.getBoundingClientRect ??= rect;
