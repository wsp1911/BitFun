import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/primitives/OverflowText/overflowMeasurement.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { observeOverflowText } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

// Controlled browser notifications and geometry, not a simulation of layout cost.
function browser({ resizeObserver = true } = {}) {
  const frames = new Map();
  const resizes = [];
  const mutations = [];
  let sequence = 0;
  const view = new EventTarget();
  view.requestAnimationFrame = callback => { frames.set(++sequence, callback); return sequence; };
  view.cancelAnimationFrame = id => frames.delete(id);
  function observerType(instances) {
    return class {
      targets = [];
      disconnected = false;
      constructor(callback) { this.callback = callback; instances.push(this); }
      observe(target) { this.targets.push(target); }
      disconnect() { this.disconnected = true; }
      notify() { this.callback([]); }
    };
  }
  if (resizeObserver) view.ResizeObserver = observerType(resizes);
  view.MutationObserver = observerType(mutations);
  const document = { defaultView: view, fonts: new EventTarget() };
  const reads = [];
  return {
    view, document, frames, resizes, mutations, reads,
    element(name, geometry = {}) {
      const sizes = { clientWidth: 100, clientHeight: 20, scrollWidth: 160, scrollHeight: 20, ...geometry };
      const element = { ownerDocument: document };
      for (const property of Object.keys(sizes)) {
        Object.defineProperty(element, property, { get() { reads.push(`${name}.${property}`); return sizes[property]; } });
      }
      return { element, sizes };
    },
    flush() {
      const callbacks = Array.from(frames.values());
      frames.clear();
      callbacks.forEach(callback => callback());
    },
  };
}

test("mounts and repeated notifications share one deferred read phase before any publication", () => {
  const env = browser();
  const a = env.element("a");
  const b = env.element("b");
  const values = [];
  const disposeA = observeOverflowText(a.element, a.element, { observeMutations: true }, next => {
    // Publishing A can change B's layout. B must already have been measured.
    b.sizes.scrollWidth = 900;
    values.push(next);
  });
  const disposeB = observeOverflowText(b.element, b.element, { observeMutations: false }, next => values.push(next));
  env.resizes.forEach(observer => observer.notify());
  env.mutations[0].notify();
  env.document.fonts.dispatchEvent(new Event("loadingdone"));
  assert.equal(env.frames.size, 1);
  assert.deepEqual(env.reads, []);
  assert.deepEqual(values, []);
  env.flush();
  assert.deepEqual(values, [{ distance: 60, isOverflowing: true }, { distance: 60, isOverflowing: true }]);
  assert.equal(env.reads.length, 4);
  assert.equal(env.frames.size, 0);
  disposeA(); disposeB();
});

test("font, rich descendant and resize changes use the latest dimensions and observe both boxes", () => {
  const env = browser();
  const root = env.element("root");
  const content = env.element("content");
  const values = [];
  const dispose = observeOverflowText(root.element, content.element, { observeMutations: true }, next => values.push(next));
  assert.deepEqual(env.resizes[0].targets, [root.element, content.element]);
  env.flush();
  content.sizes.scrollWidth = 220;
  env.document.fonts.dispatchEvent(new Event("loadingdone"));
  env.flush();
  assert.equal(values.at(-1).distance, 120);
  content.sizes.scrollWidth = 80;
  env.mutations[0].notify();
  env.flush();
  assert.deepEqual(values.at(-1), { distance: 0, isOverflowing: false });
  env.mutations[0].notify();
  env.flush();
  assert.equal(values.length, 4, "unchanged clipping still publishes so rich tooltip text can refresh");
  root.sizes.clientWidth = 50;
  env.resizes[0].notify();
  env.flush();
  assert.deepEqual(values.at(-1), { distance: 30, isOverflowing: true });
  dispose();
});

test("multiline clipping, zero-width labels and single-line font boxes retain their semantics", () => {
  const env = browser();
  const { element, sizes } = env.element("label", { scrollWidth: 100, scrollHeight: 60 });
  const values = [];
  let dispose = observeOverflowText(element, element, { observeMutations: false }, next => values.push(next));
  env.flush();
  assert.deepEqual(values.at(-1), { distance: 0, isOverflowing: false });
  assert.ok(!env.reads.some(read => /Height/.test(read)));
  dispose();
  dispose = observeOverflowText(element, element, { lines: 2, observeMutations: false }, next => values.push(next));
  env.flush();
  assert.deepEqual(values.at(-1), { distance: 0, isOverflowing: true });
  sizes.clientWidth = 0;
  env.resizes.at(-1).notify();
  env.flush();
  assert.equal(values.at(-1).isOverflowing, false);
  dispose();
});

test("cleanup cancels stale work, listeners and observer deliveries; a remount gets fresh options", () => {
  const env = browser({ resizeObserver: false });
  const { element } = env.element("label", { scrollWidth: 100, scrollHeight: 60 });
  const values = [];
  const dispose = observeOverflowText(element, element, { observeMutations: true }, () => assert.fail("disposed publication"));
  dispose(); dispose();
  assert.equal(env.frames.size, 0);
  env.view.dispatchEvent(new Event("resize"));
  env.document.fonts.dispatchEvent(new Event("loadingdone"));
  env.mutations[0].notify();
  env.flush();
  assert.deepEqual(env.reads, []);
  assert.equal(env.mutations[0].disconnected, true);
  const disposeNew = observeOverflowText(element, element, { lines: 2, observeMutations: false }, next => values.push(next));
  env.flush();
  env.view.dispatchEvent(new Event("resize"));
  env.flush();
  assert.deepEqual(values, [{ distance: 0, isOverflowing: true }, { distance: 0, isOverflowing: true }]);
  disposeNew();
});

test("a publication can unmount another label without publishing its stale result", () => {
  const env = browser();
  const { element } = env.element("label");
  let disposeB;
  const disposeA = observeOverflowText(element, element, { observeMutations: false }, () => disposeB());
  disposeB = observeOverflowText(element, element, { observeMutations: false }, () => assert.fail("unmounted publication"));
  env.flush();
  disposeA();
  assert.equal(env.resizes[1].disconnected, true);
});

test("separate documents use their own animation frames", () => {
  const a = browser();
  const b = browser();
  const values = [];
  const elementA = a.element("a").element;
  const elementB = b.element("b").element;
  const disposeA = observeOverflowText(elementA, elementA, { observeMutations: false }, () => values.push("a"));
  const disposeB = observeOverflowText(elementB, elementB, { observeMutations: false }, () => values.push("b"));
  a.flush();
  assert.deepEqual(values, ["a"]);
  assert.equal(b.frames.size, 1);
  b.flush();
  assert.deepEqual(values, ["a", "b"]);
  disposeA(); disposeB();
});
