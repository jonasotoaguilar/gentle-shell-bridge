import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { bridgeApi } from "../src/api.ts";
import { resetNoticesForTests, snapshotNotices } from "../src/notices.ts";
import {
  KEYMAP_RESOLVER_KEY,
  PLUGIN_SURFACE_KEY,
  registerCommands,
  registerKeymap,
  resolveKeymap,
} from "../src/plugin-surface.ts";

// The surface a plugin writes and the host reads: what a registration publishes, what the
// disposer removes, which ids and labels are refused, and the key resolution that keeps ONE
// implementation of environment-then-saved-then-default.

interface Surface {
  schema?: unknown;
  keymaps?: () => unknown;
  commands?: () => unknown;
}

const STATE_KEY = Symbol.for("gentle-shell-bridge/plugin-surface/v1.state");

/** The published surface, read the way the host reads it. */
function surface(): Surface {
  return (globalThis as Record<symbol, unknown>)[PLUGIN_SURFACE_KEY] as Surface;
}

function readKeymaps(): Record<string, unknown>[] {
  return (surface().keymaps?.() ?? []) as Record<string, unknown>[];
}

function readCommands(): Record<string, unknown>[] {
  return (surface().commands?.() ?? []) as Record<string, unknown>[];
}

beforeEach(() => {
  // The surface object is published once per process; the state behind it is what a test resets.
  delete (globalThis as Record<symbol, unknown>)[STATE_KEY];
  delete (globalThis as Record<symbol, unknown>)[KEYMAP_RESOLVER_KEY];
  resetNoticesForTests();
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[STATE_KEY];
  delete (globalThis as Record<symbol, unknown>)[KEYMAP_RESOLVER_KEY];
});

test("a registration reaches the published surface, and the disposer removes exactly that one", () => {
  const dispose = registerKeymap({ id: "panel:open", label: "Open panel", defaultKey: "alt+p" });
  assert.deepEqual(readKeymaps(), [{ id: "panel:open", label: "Open panel", defaultKey: "alt+p" }]);
  dispose();
  assert.deepEqual(readKeymaps(), []);
});

test("the disposer of a replaced registration never deletes its successor", () => {
  const first = registerKeymap({ id: "panel:open", label: "Open panel", defaultKey: "alt+p" });
  registerKeymap({ id: "panel:open", label: "Open the panel", defaultKey: "ctrl+p" });
  first();
  assert.deepEqual(readKeymaps(), [{ id: "panel:open", label: "Open the panel", defaultKey: "ctrl+p" }]);
});

test("a duplicate id replaces in place and is reported, never silently taken over", () => {
  registerKeymap({ id: "panel:open", label: "Open panel" });
  registerKeymap({ id: "panel:open", label: "Open the panel" });
  assert.deepEqual(readKeymaps().map((entry) => entry.label), ["Open the panel"]);
  assert.ok(snapshotNotices().entries.some((entry) => entry.message.includes('keymap "panel:open" was registered twice')));
});

test("a command: id is refused with the reason, so a plugin cannot claim a palette binding", () => {
  assert.throws(
    () => registerKeymap({ id: "command:gentle:changes", label: "Fake" }),
    /reserved.*command:/u,
  );
});

test("an empty id, label or an optional field of the wrong type is refused before anything is published", () => {
  assert.throws(() => registerKeymap({ id: "  ", label: "Open panel" }), /id must be a non-empty string/u);
  assert.throws(() => registerKeymap({ id: "panel:open", label: "" }), /label must be a non-empty string/u);
  assert.throws(
    () => registerKeymap({ id: "panel:open", label: "Open panel", defaultKey: 7 as unknown as string }),
    /defaultKey must be a non-empty string/u,
  );
  assert.deepEqual(readKeymaps(), []);
});

test("the surface answers with a copy: what the host holds cannot change what the bridge owns", () => {
  registerKeymap({ id: "panel:open", label: "Open panel" });
  const held = readKeymaps();
  held.push({ id: "intruder", label: "Intruder" });
  assert.deepEqual(readKeymaps().map((entry) => entry.id), ["panel:open"]);
});

test("registerCommands takes one item or many, joins the section it names, and disposes exactly its own", () => {
  const disposeOne = registerCommands({ id: "panel:open", label: "Open panel", command: "panel:open", section: "Session" });
  const disposeMany = registerCommands([
    { id: "panel:close", label: "Close panel", command: "panel:close" },
    { id: "panel:focus", label: "Focus panel", command: "panel:focus", section: "Panel" },
  ]);
  assert.deepEqual(readCommands().map((entry) => entry.id), ["panel:open", "panel:close", "panel:focus"]);
  assert.equal(readCommands()[0]?.section, "Session");
  assert.equal(readCommands()[1]?.section, undefined);
  disposeOne();
  assert.deepEqual(readCommands().map((entry) => entry.id), ["panel:close", "panel:focus"]);
  disposeMany();
  assert.deepEqual(readCommands(), []);
});

test("the same id twice in one call is refused whole, so a batch never lands half-registered", () => {
  assert.throws(
    () => registerCommands([
      { id: "panel:close", label: "Close panel", command: "panel:close" },
      { id: "panel:close", label: "Close panel again", command: "panel:close" },
    ]),
    /appears twice in one registration/u,
  );
  assert.deepEqual(readCommands(), []);
});

test("a second call with the same id replaces in place and is reported, never a stack", () => {
  const first = registerCommands({ id: "panel:open", label: "Open panel", command: "panel:open" });
  registerCommands({ id: "panel:open", label: "Open the panel", command: "panel:open" });
  assert.deepEqual(readCommands().map((entry) => entry.label), ["Open the panel"]);
  first();
  assert.deepEqual(readCommands().map((entry) => entry.label), ["Open the panel"]);
  assert.ok(snapshotNotices().entries.some((entry) => entry.message.includes('palette item "panel:open" was registered twice')));
});

test("the published API object carries the three members and stays frozen", () => {
  const api = bridgeApi();
  assert.ok(api, "the API is published");
  assert.equal(typeof api.registerKeymap, "function");
  assert.equal(typeof api.registerCommands, "function");
  assert.equal(typeof api.resolveKeymap, "function");
  assert.ok(Object.isFrozen(api));
});

test("resolveKeymap says why it cannot answer when no shell publishes a resolver", () => {
  const resolution = resolveKeymap("panel:open");
  assert.equal(resolution.key, undefined);
  assert.match(resolution.unavailable ?? "", /gentle-pi\/keymaps\/v1/u);
});

test("resolveKeymap answers with the shell's key, and reports a throwing shell instead of throwing", () => {
  (globalThis as Record<symbol, unknown>)[KEYMAP_RESOLVER_KEY] = { schema: 1, effectiveKey: () => "ctrl+p" };
  assert.deepEqual(resolveKeymap("panel:open"), { key: "ctrl+p" });
  (globalThis as Record<symbol, unknown>)[KEYMAP_RESOLVER_KEY] = { schema: 1, effectiveKey: () => { throw new Error("boom"); } };
  assert.match(resolveKeymap("panel:open").unavailable ?? "", /boom/u);
  (globalThis as Record<symbol, unknown>)[KEYMAP_RESOLVER_KEY] = { schema: 2, effectiveKey: () => "ctrl+p" };
  assert.match(resolveKeymap("panel:open").unavailable ?? "", /does not publish its keymap resolver/u);
});
