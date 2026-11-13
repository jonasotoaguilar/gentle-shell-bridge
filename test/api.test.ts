/**
 * The runtime handshake (S1, S5 "zero extra steps"): the published API object, its shape gate, the
 * early-loader queue and the drain the entry runs on `session_start`.
 *
 * A plugin and the bridge are two independent projects. Pi gives them one sanctioned channel that
 * needs no path: `globalThis`. These tests pin that channel only — the symbols, the frozen object,
 * the queue and the gating rules — because a path or an environment variable is exactly what the
 * rejected design offered and what this design replaces.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  API_SCHEMA,
  API_VERSION,
  BRIDGE_API_KEY,
  BRIDGE_PENDING_KEY,
  VERSION,
  attachBridge,
  drainBridgeQueue,
  isBridgeApi,
  publishBridgeApi,
  resetBridgeApiForTests,
  type BridgeApi,
} from "../src/api.ts";
import {
  resetBusForTests,
  resetSectionsForTests,
  snapshotProviders,
  snapshotSections,
} from "../src/bus.ts";
import { disableCaptureBackend, getCaptureDiagnostics, resetCaptureStateForTests } from "../src/capture.ts";
import gentleShellBridge, {
  type BridgeExtensionApi,
  type BridgeSessionHandler,
} from "../src/extension.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetNoticesForTests, snapshotNotices } from "../src/notices.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import {
  disableSidebarBackend,
  resetSidebarStateForTests,
} from "../src/sidebar.ts";
import { resetSectionFailuresForTests } from "../src/sidebar-render.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { RowProvider, SidebarSection } from "../src/types.ts";
import { createFakeHost, type FakeHost, type FakeUiTarget } from "./fake-host.ts";
import {
  cardBody,
  cardTitles,
  fakeTui,
  registerNativeFooter,
  resetSidebar,
} from "./fake-sidebar.ts";

const hostSlot = (): Record<symbol, unknown> => globalThis as unknown as Record<symbol, unknown>;
const pendingInits = (): unknown[] => {
  const queue = hostSlot()[BRIDGE_PENDING_KEY];
  return Array.isArray(queue) ? queue : [];
};

const provider = (id: string): RowProvider => ({ id, category: "Cards", rows: () => [] });
const section = (id: string, title = "MUSIC"): SidebarSection => ({
  id,
  title,
  meta: () => "1 playing",
  lines: () => ["track  one"],
});

/** Every console write the terminal would show; the bridge must produce none. */
const captureConsole = (): { writes: string[]; restore: () => void } => {
  const writes: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const record =
    (method: string) =>
    (...args: unknown[]): void => {
      writes.push(`${method}: ${args.map((arg) => String(arg)).join(" ")}`);
    };
  console.log = record("log");
  console.warn = record("warn");
  console.error = record("error");
  return {
    writes,
    restore: () => {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    },
  };
};

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-api-"));
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
  resetNoticesForTests();
  resetBusForTests();
  resetSectionsForTests();
  resetSidebar();
  resetSidebarStateForTests();
  resetSectionFailuresForTests();
  resetStoreStateForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetRowBuildStateForTests();
  disableCaptureBackend();
  disableSidebarBackend();
});

test.afterEach(() => {
  disableCaptureBackend();
  disableSidebarBackend();
});

// ---------------------------------------------------------------------------------------------
// The published object
// ---------------------------------------------------------------------------------------------

test("publishing stores one frozen, versioned API object at the stable symbol", () => {
  const api = publishBridgeApi();

  assert.equal(hostSlot()[BRIDGE_API_KEY], api, "the slot holds exactly the object published");
  assert.ok(Object.isFrozen(api), "the published contract is frozen: nobody may extend it in place");
  assert.deepEqual(Object.keys(api).sort(), [
    "VERSION",
    "createStore",
    "drain",
    "registerRows",
    "registerSection",
    "schema",
    "version",
  ]);
  assert.equal(api.schema, "gentle-shell-bridge/api");
  assert.equal(api.version, 1);
  assert.equal(api.VERSION, VERSION);
  assert.equal(api.schema, API_SCHEMA);
  assert.equal(api.version, API_VERSION);
  assert.equal(isBridgeApi(api), true);
});

test("the published functions are the working ones, not a stale copy", () => {
  const api = publishBridgeApi();

  const disposeRows = api.registerRows(provider("loon.banner-source"));
  const disposeSection = api.registerSection(section("loon.music"));

  assert.deepEqual(snapshotProviders().map((registered) => registered.id), ["loon.banner-source"]);
  assert.deepEqual(snapshotSections().map((registered) => registered.id), ["loon.music"]);

  disposeSection();
  disposeRows();
  assert.deepEqual(snapshotProviders(), []);
  assert.deepEqual(snapshotSections(), []);
});

test("the shape gate accepts only the v1 surface it advertises", () => {
  const valid = {
    schema: API_SCHEMA,
    version: API_VERSION,
    registerRows: () => () => {},
    registerSection: () => () => {},
    createStore: () => ({}),
  };

  assert.equal(isBridgeApi(valid), true);

  // Every mismatch is "absent", so the caller falls back to the queue instead of an error path.
  for (const rejected of [
    undefined,
    null,
    "gentle-shell-bridge",
    42,
    {},
    { ...valid, schema: "gentle-shell-bridge/api/v2" },
    { ...valid, version: 2 },
    { ...valid, version: "1" },
    { schema: API_SCHEMA, version: API_VERSION },
    { ...valid, registerRows: undefined },
    { ...valid, registerSection: "nope" },
    { ...valid, createStore: {} },
  ]) {
    assert.equal(isBridgeApi(rejected), false, `must reject ${JSON.stringify(rejected)}`);
  }
});

test("a second publish keeps the first object: first wins", () => {
  const first = publishBridgeApi();
  const second = publishBridgeApi();

  assert.equal(second, first);
  assert.equal(hostSlot()[BRIDGE_API_KEY], first);
});

test("two loaded copies of the module publish one object and both work through it", async () => {
  const first = publishBridgeApi();

  // Pi loads every extension with `moduleCache: false`, so this package genuinely exists twice in
  // one process. A second copy is a second module instance, not a second global slot.
  const copyPath = new URL("../src/api.ts?second-copy", import.meta.url).href;
  const second = (await import(copyPath)) as typeof import("../src/api.ts");

  assert.equal(hostSlot()[BRIDGE_API_KEY], first, "the second copy never overwrote the slot");
  const secondApi = second.publishBridgeApi();
  assert.equal(secondApi, first, "and publishing again hands the same object back");
  assert.equal(second.isBridgeApi(hostSlot()[BRIDGE_API_KEY]), true);

  // Both copies register into the same process-global bus, which is what makes them interchangeable.
  first.registerRows(provider("shared"));
  secondApi.registerRows(provider("shared"));
  assert.deepEqual(snapshotProviders().map((registered) => registered.id), ["shared"]);
  secondApi.registerSection(section("shared.section"));
  assert.deepEqual(snapshotSections().map((registered) => registered.id), ["shared.section"]);
});

// ---------------------------------------------------------------------------------------------
// The early-loader queue
// ---------------------------------------------------------------------------------------------

test("attachBridge runs the init now when an API is already published", () => {
  const api = publishBridgeApi();
  const seen: BridgeApi[] = [];

  attachBridge((given) => seen.push(given));

  assert.deepEqual(seen, [api], "the init ran synchronously, with the published object");
  assert.deepEqual(pendingInits(), [], "and nothing was queued");
});

test("attachBridge queues when the bridge is absent, and the publish drains it", () => {
  let ran = 0;
  attachBridge((api) => {
    ran += 1;
    api.registerRows(provider("loon.banner-source"));
  });

  assert.equal(ran, 0, "nothing runs before the bridge exists");
  assert.equal(pendingInits().length, 1);
  assert.deepEqual(snapshotProviders(), []);

  publishBridgeApi();

  assert.equal(ran, 1, "publishing drains the queue");
  assert.deepEqual(pendingInits(), [], "and empties it");
  assert.deepEqual(snapshotProviders().map((registered) => registered.id), [
    "loon.banner-source",
  ]);
});

test("two drains leave one provider and one section, never a duplicate", () => {
  // Two copies of one plugin (a double load) queue two initialisers that register the same ids.
  const queueBoth = (): void => {
    attachBridge((api) => {
      api.registerRows(provider("bash-card-example.rendering"));
      api.registerSection(section("bash-card.status", "BASH CARD"));
    });
    attachBridge((api) => {
      api.registerRows(provider("bash-card-example.rendering"));
      api.registerSection(section("bash-card.status", "BASH CARD"));
    });
  };

  queueBoth();
  publishBridgeApi(); // drain one: publish time

  assert.deepEqual(snapshotProviders().map((registered) => registered.id), [
    "bash-card-example.rendering",
  ]);
  assert.deepEqual(snapshotSections().map((registered) => registered.id), ["bash-card.status"]);

  drainBridgeQueue(); // drain two: session_start
  drainBridgeQueue(); // drain three: a second session_start

  assert.deepEqual(snapshotProviders().map((registered) => registered.id), [
    "bash-card-example.rendering",
  ]);
  assert.deepEqual(snapshotSections().map((registered) => registered.id), ["bash-card.status"]);

  // A plugin that arrives after the first drain, with the same stable ids, is a replacement too.
  queueBoth();
  drainBridgeQueue();
  assert.equal(snapshotProviders().length, 1);
  assert.equal(snapshotSections().length, 1);
});

test("a queued init that throws is isolated: the rest run and the drain never escapes", () => {
  const ran: string[] = [];
  const captured = captureConsole();
  try {
    attachBridge(() => {
      throw new Error("plugin bug");
    });
    attachBridge(() => {
      ran.push("second");
    });
    assert.doesNotThrow(() => publishBridgeApi());
  } finally {
    captured.restore();
  }

  assert.deepEqual(ran, ["second"]);
  assert.deepEqual(captured.writes, [], "the failure is not written to the terminal");
  const notices = snapshotNotices().entries;
  assert.equal(notices.length, 1, "one notice, kept for /bridge-status and the TUI");
  assert.equal(notices[0].level, "warning");
  assert.match(notices[0].message, /initiali[sz]er|init/);
  assert.equal(notices[0].emitted, false, "no UI has seen it yet");
});

// ---------------------------------------------------------------------------------------------
// Version skew: an incompatible object is absent, never an error and never reset
// ---------------------------------------------------------------------------------------------

const usableSurface = (): Record<string, unknown> => ({
  schema: API_SCHEMA,
  version: API_VERSION,
  registerRows: () => () => {},
  registerSection: () => () => {},
  createStore: () => ({ get: () => undefined, set: () => {} }),
});

test("an object that fails the gate is absent: the caller queues, nothing throws, one notice", () => {
  for (const incompatible of [
    { ...usableSurface(), schema: "someone-else/api" },
    { ...usableSurface(), version: 2 },
    { schema: API_SCHEMA, version: API_VERSION },
  ]) {
    resetBridgeApiForTests();
    resetNoticesForTests();
    hostSlot()[BRIDGE_API_KEY] = incompatible;
    const seen: unknown[] = [];
    const captured = captureConsole();
    try {
      assert.doesNotThrow(() => {
        attachBridge((api) => seen.push(api));
        attachBridge((api) => seen.push(api));
      });
    } finally {
      captured.restore();
    }

    assert.deepEqual(seen, [], "a mismatched object is never handed to a plugin");
    assert.equal(pendingInits().length, 2, "both initialisers are queued instead");
    assert.deepEqual(captured.writes, [], "the skew is never written to the terminal");
    const notices = snapshotNotices().entries;
    assert.equal(notices.length, 1, "and it is recorded once, not per call");
    assert.match(notices[0].message, /incompatible|unsupported|version|not the/u);
  }
});

test("an incompatible slot is never reset, and the bridge still drains with a working API", () => {
  const incompatible = { ...usableSurface(), version: 2 };
  hostSlot()[BRIDGE_API_KEY] = incompatible;
  const captured = captureConsole();
  let drainedWith: BridgeApi | undefined;
  try {
    attachBridge((api) => {
      drainedWith = api;
      api.registerSection(section("loon.music"));
    });
    publishBridgeApi();
  } finally {
    captured.restore();
  }

  assert.deepEqual(captured.writes, []);

  assert.equal(hostSlot()[BRIDGE_API_KEY], incompatible, "the slot is left exactly as it was");
  assert.equal(isBridgeApi(hostSlot()[BRIDGE_API_KEY]), false);
  assert.ok(drainedWith !== undefined, "the queued initialiser still ran");
  assert.equal(isBridgeApi(drainedWith), true, "with a working API, so the plugin is not stranded");
  assert.deepEqual(snapshotSections().map((registered) => registered.id), ["loon.music"]);
});

// ---------------------------------------------------------------------------------------------
// Through the entry: the plugin that loaded first still reaches both surfaces
// ---------------------------------------------------------------------------------------------

type UiWithWidget = FakeUiTarget & {
  setWidget?: (key: string, factory: (tui: unknown, theme: unknown) => unknown) => void;
};

const installWidgetSurface = (host: FakeHost): void => {
  const ui = host.ui as UiWithWidget;
  ui.setWidget = (_key, factory) => {
    factory(fakeTui(), { name: "fake-theme" });
  };
};

const armThroughEntry = (host: FakeHost): void => {
  const handlers: BridgeSessionHandler[] = [];
  const pi: BridgeExtensionApi = {
    on(_event, handler) {
      handlers.push(handler);
    },
    registerCommand() {},
  };
  gentleShellBridge(pi);
  assert.equal(handlers.length, 1);
  handlers[0]({}, { hasUI: true, ui: host.ui });
};

test("a plugin that loaded before the bridge renders its section and its Sections toggle", () => {  const host = createFakeHost();
  installWidgetSurface(host);
  registerNativeFooter(); // the host's own rail

  // The plugin loads first: no bridge yet, so its init is queued and registers nothing.
  attachBridge((api) => {
    api.registerRows({
      id: "loon.banner-source",
      category: "Cards",
      rows: () => [
        {
          category: "Cards",
          label: "Loon: banner source",
          choice: { setting: "Loon → Banner source", value: "on", current: () => true },
          action: () => {},
        },
      ],
    });
    api.registerSection(section("loon.music"));
  });
  assert.deepEqual(snapshotSections(), [], "nothing is registered before the bridge loads");

  publishBridgeApi(); // the bridge loads, publishes and drains

  armThroughEntry(host); // session_start
  host.buildMenu();

  assert.deepEqual(cardTitles(), ["FOOTER", "MUSIC"], "the queued section reached the rail");
  assert.deepEqual(cardBody("MUSIC"), ["track  one"]);
  const toggle = host.toggleLines().find((line) => line.startsWith("Section: loon.music"));
  assert.ok(toggle !== undefined, "and its toggle reached Sections");
  assert.ok(toggle.includes("● shown") && toggle.includes("○ hidden"));
  assert.ok(
    host.toggleLines().some((line) => line.startsWith("Loon → Banner source")),
    "the queued provider's rows reached the menu too",
  );
});

test("PRESERVE: a session_start without a UI still arms nothing, and now also drains", () => {
  attachBridge((api) => api.registerRows(provider("queued.rows")));
  const handlers: BridgeSessionHandler[] = [];
  const pi: BridgeExtensionApi = {
    on(_event, handler) {
      handlers.push(handler);
    },
    registerCommand() {},
  };
  gentleShellBridge(pi);

  handlers[0]({}, { hasUI: false });

  assert.equal(getCaptureDiagnostics().armedTargets, 0, "no UI still means no arming");
  assert.deepEqual(
    snapshotProviders().map((registered) => registered.id),
    ["queued.rows"],
    "the queue is drained even when there is no menu to reach, so a later build sees the rows",
  );
});
