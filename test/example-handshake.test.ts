/**
 * The worked example's runtime handshake (S1, S5 "zero extra steps").
 *
 * `examples/bash-card.ts` is what a plugin author copies. It must reach the bridge with no path,
 * no environment variable and no import of the package — only the two symbols — and it must work
 * whichever side loads first. These tests drive the real file, in a fresh module instance per
 * scenario, against the published contract.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BRIDGE_PENDING_KEY,
  publishBridgeApi,
  resetBridgeApiForTests,
} from "../src/api.ts";
import { resetBusForTests, resetSectionsForTests, snapshotProviders, snapshotSections } from "../src/bus.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { CustomizeRow, InlineHelpers } from "../src/types.ts";

const hostSlot = (): Record<symbol, unknown> => globalThis as unknown as Record<symbol, unknown>;
const pendingInits = (): unknown[] => {
  const queue = hostSlot()[BRIDGE_PENDING_KEY];
  return Array.isArray(queue) ? queue : [];
};

interface FakePi {
  registerToolRenderer?: (resolver: unknown) => void;
}

type ExampleInit = (pi: FakePi) => () => void;

/**
 * One fresh module instance per scenario: the example keeps nothing on `globalThis`, so a query
 * string is enough to model "this file was loaded again".
 */
const loadExample = async (tag: string): Promise<ExampleInit> => {
  const specifier = new URL(`../examples/bash-card.ts?${tag}`, import.meta.url).href;
  const loaded = (await import(specifier)) as { default: ExampleInit };
  return loaded.default;
};

const recordingPi = (): { pi: FakePi; registrations: () => number } => {
  const state = { registrations: 0 };
  const pi: FakePi = {
    registerToolRenderer: () => {
      state.registrations += 1;
    },
  };
  return { pi, registrations: () => state.registrations };
};

const captureWarnings = (): { messages: string[]; restore: () => void } => {
  const messages: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    messages.push(args.map((arg) => String(arg)).join(" "));
  };
  return {
    messages,
    restore: () => {
      console.warn = original;
    },
  };
};

const inlineHelpers: InlineHelpers = {
  input: async () => undefined,
  confirm: async () => true,
  capture: async () => undefined,
};

let configHome: string;
let previousConfigHome: string | undefined;
let previousModuleEnv: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-example-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  previousModuleEnv = process.env.GENTLE_SHELL_BRIDGE_MODULE;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
  // The rejected design's override must not be needed for anything below; make sure it cannot
  // silently supply the bridge in these tests.
  delete process.env.GENTLE_SHELL_BRIDGE_MODULE;
});

test.after(() => {
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  if (previousModuleEnv === undefined) delete process.env.GENTLE_SHELL_BRIDGE_MODULE;
  else process.env.GENTLE_SHELL_BRIDGE_MODULE = previousModuleEnv;
  rmSync(configHome, { recursive: true, force: true });
});

test.beforeEach(() => {
  rmSync(join(configHome, "gentle-shell-bridge"), { recursive: true, force: true });
  resetBridgeApiForTests();
  resetBusForTests();
  resetSectionsForTests();
  resetStoreStateForTests();
});

const sectionContext = (): { theme: unknown; configHome: string } => ({
  theme: undefined,
  configHome,
});

const rowContext = sectionContext;

const providerById = (id: string): ReturnType<typeof snapshotProviders>[number] | undefined =>
  snapshotProviders().find((registered) => registered.id === id);

test("with no bridge loaded the example warns, registers nothing and does not throw", async () => {
  const warnings = captureWarnings();
  const { pi, registrations } = recordingPi();
  try {
    const init = await loadExample("no-bridge");
    assert.doesNotThrow(() => init(pi));
  } finally {
    warnings.restore();
  }

  assert.equal(warnings.messages.length, 1, "one honest warning, not a stack trace");
  assert.match(warnings.messages[0], /not published a compatible API yet/);
  assert.match(warnings.messages[0], /queue/i);
  assert.deepEqual(pendingInits().length, 1, "the single init waits in the process-global queue");
  assert.equal(registrations(), 1, "the bash renderer is still claimed: that half needs no bridge");
  assert.deepEqual(snapshotProviders(), []);
  assert.deepEqual(snapshotSections(), []);
});

test("publishing the API drains the queued example: rows, store and section appear", async () => {
  const warnings = captureWarnings();
  const { pi } = recordingPi();
  try {
    const init = await loadExample("queued");
    init(pi);
    assert.deepEqual(snapshotSections(), []);
    assert.equal(pendingInits().length, 1);
  } finally {
    warnings.restore();
  }

  publishBridgeApi(); // the bridge loads after the plugin

  assert.deepEqual(pendingInits(), [], "the queue is emptied");
  const provider = providerById("bash-card-example.rendering");
  assert.ok(provider !== undefined, "the example's rows provider registered itself");

  const rows: CustomizeRow[] = provider.rows(rowContext());
  assert.deepEqual(
    rows.map((row) => row.choice?.value),
    ["default", "tool"],
    "the two consecutive toggle values are the plugin's own",
  );
  const toolRow = rows.find((row) => row.choice?.value === "tool");
  assert.ok(toolRow?.action !== undefined);
  toolRow.action(inlineHelpers);

  // The store really is the bridge's, and it wrote where `createStore` puts it.
  assert.deepEqual(
    JSON.parse(readFileSync(join(configHome, "gentle-shell-bridge", "bash-card-example.json"), "utf8")),
    { schemaVersion: 1, values: { bashRendering: "tool" } },
  );

  const exampleSection = snapshotSections().find((registered) => registered.id === "bash-card.status");
  assert.ok(exampleSection !== undefined, "the example's section registered itself");
  assert.equal(exampleSection.meta?.(sectionContext()), "tool", "and reads the value just written");
  const lines = exampleSection.lines(sectionContext());
  assert.deepEqual(lines, ["rendering  tool", "renderer   registered"]);
});

test("with the API published first the init runs immediately and nothing is queued", async () => {
  publishBridgeApi();
  const warnings = captureWarnings();
  const { pi, registrations } = recordingPi();
  try {
    const init = await loadExample("bridge-first");
    init(pi);
  } finally {
    warnings.restore();
  }

  assert.deepEqual(warnings.messages, [], "no waiting warning: the bridge was already there");
  assert.deepEqual(pendingInits(), [], "nothing queued");
  assert.equal(registrations(), 1);
  assert.ok(providerById("bash-card-example.rendering") !== undefined);
  assert.ok(snapshotSections().some((registered) => registered.id === "bash-card.status"));
});

test("the disposer the example returns removes both its registrations", async () => {
  publishBridgeApi();
  const warnings = captureWarnings();
  const { pi } = recordingPi();
  let dispose = (): void => {};
  try {
    const init = await loadExample("dispose");
    dispose = init(pi);
  } finally {
    warnings.restore();
  }

  assert.ok(providerById("bash-card-example.rendering") !== undefined);
  assert.ok(snapshotSections().some((registered) => registered.id === "bash-card.status"));

  dispose();

  assert.equal(providerById("bash-card-example.rendering"), undefined);
  assert.equal(snapshotSections().some((registered) => registered.id === "bash-card.status"), false);
});

test("the example's runtime path resolves no module of the bridge", () => {
  const source = readFileSync(
    new URL("../examples/bash-card.ts", import.meta.url),
    "utf8",
  );

  assert.equal(
    /GENTLE_SHELL_BRIDGE_MODULE/u.test(source),
    false,
    "the environment-variable override is gone",
  );
  assert.equal(/bridgeCandidates/u.test(source), false, "the path probing is gone");
  assert.equal(/await\s+import\s*\(/u.test(source), false, "nothing is imported at runtime");
  assert.equal(
    /from\s+["']gentle-shell-bridge["']/u.test(source),
    false,
    "the package is never imported, not even for types",
  );
  assert.match(source, /Symbol\.for\("gentle-shell-bridge\/api\/v1"\)/u);
  assert.match(source, /Symbol\.for\("gentle-shell-bridge\/pending\/v1"\)/u);
});
