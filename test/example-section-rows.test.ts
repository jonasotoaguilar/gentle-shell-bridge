/**
 * The example's sidebar section, driven through the real file (N16).
 *
 * The bridge draws the header and owns the collapse, so what the SAMPLE must prove is the part a
 * plugin author copies: a right-aligned `meta` that is live (the current rendering mode), one row
 * that is clickable and changes something a person can see, and one row that is deliberately inert.
 *
 * This file drives `examples/bash-card.ts` as loaded by Pi, not a copy of its logic: one fresh module
 * instance per scenario, the published API object, and the section it registers.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishBridgeApi, resetBridgeApiForTests } from "../src/api.ts";
import { resetBusForTests, resetSectionsForTests, snapshotSections } from "../src/bus.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { SectionRow, SidebarSection } from "../src/types.ts";

interface FakePi {
  on?: (event: string, handler: (event: unknown, ctx: { hasUI?: boolean; ui?: unknown }) => void) => void;
}

type ExampleInit = (pi: FakePi) => () => void;

const loadExample = async (tag: string): Promise<ExampleInit> => {
  const specifier = new URL(`../examples/bash-card.ts?${tag}`, import.meta.url).href;
  const loaded = (await import(specifier)) as { default: ExampleInit };
  return loaded.default;
};

const notifySurface = (): { ui: { notify: (message: string) => void } } => ({
  ui: { notify: () => {} },
});

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-example-section-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
});

test.after(() => {
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  rmSync(configHome, { recursive: true, force: true });
});

test.beforeEach(() => {
  rmSync(join(configHome, "gentle-shell-bridge"), { recursive: true, force: true });
  resetBridgeApiForTests();
  resetBusForTests();
  resetSectionsForTests();
  resetStoreStateForTests();
});

/** Load the example, run its `session_start`, and hand back the section it registered. */
async function registerExample(tag: string): Promise<SidebarSection> {
  publishBridgeApi();
  const handlers: Array<(event: unknown, ctx: { hasUI?: boolean; ui?: unknown }) => void> = [];
  const init = await loadExample(tag);
  init({ on: (_event, handler) => handlers.push(handler) });
  for (const handler of handlers) handler({}, { hasUI: true, ui: notifySurface().ui });

  const section = snapshotSections().find((registered) => registered.id === "bash-card.status");
  assert.ok(section !== undefined, "the example registers BASH CARD");
  return section;
}

const context = (): { theme: unknown; configHome: string } => ({ theme: undefined, configHome });
const firstRow = (section: SidebarSection): SectionRow => {
  const row = section.lines(context())[0];
  assert.ok(typeof row === "object", "the example uses a structured row, not just text");
  return row;
};

test("the header's meta is the live rendering mode, and the row shows it too", async () => {
  const section = await registerExample("rows-live");

  assert.equal(section.title, "BASH CARD");
  assert.equal(section.meta?.(context()), "default", "the right-aligned count is the stored mode");

  const row = firstRow(section);
  assert.equal(row.label, "rendering");
  assert.equal(row.meta, "default");
  assert.equal(row.glyph, "○");
  assert.equal(row.tone, "muted");
  assert.equal(typeof row.onClick, "function", "the row is clickable — that is its only claim to be");
});

test("one click on the rendering row changes the mode the card and the frame read", async () => {
  const section = await registerExample("rows-click");
  const row = firstRow(section);

  row.onClick?.();

  assert.equal(
    readFileSync(join(configHome, "gentle-shell-bridge", "bash-card-example.json"), "utf8").includes(
      '"bashRendering": "tool"',
    ),
    true,
    "the click wrote the same key the Cards toggle writes",
  );

  // A plugin cannot re-register to show a change: the SAME section object is read again.
  assert.equal(section.meta?.(context()), "tool", "the header's count moved");
  const after = firstRow(section);
  assert.equal(after.meta, "tool");
  assert.equal(after.glyph, "◉");
  assert.equal(after.tone, "accent");

  after.onClick?.();
  assert.equal(section.meta?.(context()), "default", "and one more click switches back");
});

test("the row that reports a fact is inert: no onClick, so the pointer cannot act on it", async () => {
  const section = await registerExample("rows-inert");
  const rows = section.lines(context());

  assert.equal(rows.length, 2);
  const second = rows[1];
  assert.equal(second, "transform  registered", "a plain string row: this load did register it");
});
