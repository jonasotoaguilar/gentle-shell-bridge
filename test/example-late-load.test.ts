/**
 * The worked example when Pi loads it BEFORE the package (the real defect), and when it loads
 * after (the case that always worked).
 *
 * Global extensions load before configured packages, so the example's `session_start` handler can
 * run before the bridge's module ever publishes. The example therefore keeps its `session_start`
 * attempt and additionally listens for the bridge's announcement, and the notice it shows says
 * which state it is in instead of claiming the bridge is not installed.
 *
 * Registration stays idempotent by id and guarded per load, so a double call — an announcement and
 * a later `session_start` — leaves exactly one of each surface.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BRIDGE_READY_EVENT,
  announceBridgeReady,
  publishBridgeApi,
  resetBridgeApiForTests,
} from "../src/api.ts";
import {
  resetBusForTests,
  resetCardStylesForTests,
  resetSectionsForTests,
  resetTransformsForTests,
  snapshotCardStyles,
  snapshotProviders,
  snapshotSections,
  snapshotTransforms,
} from "../src/bus.ts";
import gentleShellBridge, { type BridgeExtensionApi } from "../src/extension.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import { createFakeEvents, type FakeEvents } from "./fake-events.ts";

type SessionHandler = (event: unknown, ctx: { hasUI?: boolean; ui?: unknown }) => void;

interface FakePi {
  on?: (event: string, handler: SessionHandler) => void;
  events?: FakeEvents;
}

type ExampleInit = (pi: FakePi) => () => void;

/** One fresh module instance per scenario: the example keeps nothing on `globalThis`. */
const loadExample = async (tag: string): Promise<ExampleInit> => {
  const specifier = new URL(`../examples/bash-card.ts?${tag}`, import.meta.url).href;
  return ((await import(specifier)) as { default: ExampleInit }).default;
};

/**
 * The package loading in the same process: its module import publishes the object, and Pi calls
 * the extension factory with the event bus. No session handler is kept: this test is about the
 * announcement, not about the bridge arming itself.
 */
const loadBridge = (events: FakeEvents): void => {
  const pi: BridgeExtensionApi = { on() {}, registerCommand() {}, events };
  gentleShellBridge(pi);
};

const recordingPi = (events?: FakeEvents): { pi: FakePi; sessionHandlers: SessionHandler[] } => {
  const sessionHandlers: SessionHandler[] = [];
  const pi: FakePi = {
    on(_event, handler) {
      sessionHandlers.push(handler);
    },
    ...(events === undefined ? {} : { events }),
  };
  return { pi, sessionHandlers };
};

const notifySurface = (): {
  ui: { notify: (message: string, level?: string) => void };
  calls: Array<[string, string | undefined]>;
} => {
  const calls: Array<[string, string | undefined]> = [];
  return {
    ui: { notify: (message, level) => calls.push([message, level]) },
    calls,
  };
};

/** How many of each surface the example owns right now: rows, section, card style, transform. */
const surfaceCounts = (): number[] => [
  snapshotProviders().filter((registered) => registered.id === "bash-card-example.rendering").length,
  snapshotSections().filter((registered) => registered.id === "bash-card.status").length,
  snapshotCardStyles().filter((registered) => registered.id === "bash-card.plain").length,
  snapshotTransforms().filter((registered) => registered.id === "bash-card-example.bash-cards").length,
];

const ALL_FOUR = [1, 1, 1, 1];

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-late-"));
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
  resetCardStylesForTests();
  resetTransformsForTests();
  resetStoreStateForTests();
});

// ---------------------------------------------------------------------------------------------
// The defect: the plugin ran first
// ---------------------------------------------------------------------------------------------

test("a plugin loaded before the bridge registers all four surfaces when the announcement arrives", async () => {
  const bus = createFakeEvents();
  const { pi, sessionHandlers } = recordingPi(bus);
  const init = await loadExample("late-announcement");
  init(pi);

  assert.deepEqual(surfaceCounts(), [0, 0, 0, 0], "nothing registers at module load");
  assert.equal(bus.listenerCount(BRIDGE_READY_EVENT), 1, "the early loader is listening");
  assert.deepEqual(surfaceCounts(), [0, 0, 0, 0], "and still registers nothing before the bridge");

  loadBridge(bus);

  assert.deepEqual(surfaceCounts(), ALL_FOUR, "the announcement served the early loader");
  assert.equal(bus.listenerCount(BRIDGE_READY_EVENT), 0, "and it stopped listening afterwards");

  // A `reload` fires `session_start` again: the example must not register a second copy.
  const { ui } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });
  assert.deepEqual(surfaceCounts(), ALL_FOUR, "one of each surface, not two");
});

test("the announcement alone is enough: a late bridge registers with no session_start at all", async () => {
  const bus = createFakeEvents();
  const { pi, sessionHandlers } = recordingPi(bus);
  const init = await loadExample("late-no-session");
  init(pi);

  // The announced bridge arrives while no session has started.
  publishBridgeApi();
  announceBridgeReady(bus);

  assert.deepEqual(surfaceCounts(), ALL_FOUR);
  assert.equal(sessionHandlers.length, 1, "the handler is still there for the next session");

  const { ui, calls } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });
  assert.deepEqual(calls, [], "no notice: the surfaces are registered and nothing is pending");
});

test("session_start before and after the announcement leaves exactly one of each surface", async () => {
  const bus = createFakeEvents();
  const { pi, sessionHandlers } = recordingPi(bus);
  const init = await loadExample("late-both");
  init(pi);
  const { ui } = notifySurface();

  // The real order: the example's handler runs first, finds nothing, and waits.
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });
  assert.deepEqual(surfaceCounts(), [0, 0, 0, 0], "no bridge yet: nothing to register with");

  loadBridge(bus);
  assert.deepEqual(surfaceCounts(), ALL_FOUR, "the announcement did the work");

  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });
  assert.deepEqual(surfaceCounts(), ALL_FOUR, "the later session_start adds no duplicate");
});

// ---------------------------------------------------------------------------------------------
// The order that always worked: the package loaded first
// ---------------------------------------------------------------------------------------------

test("a plugin loaded after the bridge registers from session_start and leaves no listener", async () => {
  const bus = createFakeEvents();
  loadBridge(bus);

  const { pi, sessionHandlers } = recordingPi(bus);
  const init = await loadExample("early-bridge");
  init(pi);

  assert.equal(
    bus.listenerCount(BRIDGE_READY_EVENT),
    0,
    "the API was already published: nothing to wait for, so nothing is subscribed",
  );
  assert.deepEqual(surfaceCounts(), [0, 0, 0, 0], "and still nothing at module load");

  const { ui, calls } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });
  assert.deepEqual(calls, []);
  assert.deepEqual(surfaceCounts(), ALL_FOUR);
});

test("disposing before the announcement drops the listener and registers nothing", async () => {
  const bus = createFakeEvents();
  const { pi } = recordingPi(bus);
  const init = await loadExample("late-dispose");
  const dispose = init(pi);

  assert.equal(bus.listenerCount(BRIDGE_READY_EVENT), 1);
  dispose();
  assert.equal(bus.listenerCount(BRIDGE_READY_EVENT), 0, "a disposed load hears nothing");

  loadBridge(bus);
  assert.deepEqual(surfaceCounts(), [0, 0, 0, 0]);
});

test("an announcement backed by no published object registers nothing", async () => {
  const bus = createFakeEvents();
  const { pi } = recordingPi(bus);
  const init = await loadExample("late-foreign");
  init(pi);

  bus.emit(BRIDGE_READY_EVENT, { schema: "someone-else/api", version: 1 });

  assert.deepEqual(surfaceCounts(), [0, 0, 0, 0], "the symbol decides, never the payload");
  assert.equal(bus.listenerCount(BRIDGE_READY_EVENT), 1, "and the example is still waiting");
});

// ---------------------------------------------------------------------------------------------
// The notice: two honest states
// ---------------------------------------------------------------------------------------------

test("with a bus but no bridge yet the notice says it is waiting for the announcement", async () => {
  const bus = createFakeEvents();
  const { pi, sessionHandlers } = recordingPi(bus);
  const init = await loadExample("notice-waiting");
  init(pi);

  const { ui, calls } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });

  assert.equal(calls.length, 1, "one notice, delivered once");
  assert.equal(calls[0][1], "warning");
  const message = calls[0][0];
  assert.match(message, /waiting for the "gentle-shell-bridge:ready" announcement/u);
  assert.match(message, /registers the Cards toggle/u);
  assert.match(message, /if it is not installed, or the published object is incompatible, nothing arrives/u);
  assert.doesNotMatch(
    message,
    /no compatible gentle-shell-bridge is installed/u,
    "the example must not claim the bridge is missing when it may simply not be loaded yet",
  );
});

test("with no bus and no bridge the notice says no announcement can arrive", async () => {
  const { pi, sessionHandlers } = recordingPi();
  const init = await loadExample("notice-no-bus");
  init(pi);

  const { ui, calls } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });

  assert.equal(calls.length, 1);
  const message = calls[0][0];
  assert.match(message, /no cross-extension event bus/u);
  assert.match(message, /adds nothing/u);
  assert.match(message, /no compatible gentle-shell-bridge is installed/u);
  assert.doesNotMatch(message, /waiting for/u, "there is nothing to wait for without a bus");
});

test("a waiting notice is withdrawn, not delivered stale, once the announcement registers the surfaces", async () => {
  const bus = createFakeEvents();
  const { pi, sessionHandlers } = recordingPi(bus);
  const init = await loadExample("notice-withdrawn");
  init(pi);

  // The session starts with no UI, so nothing is delivered yet.
  for (const handler of sessionHandlers) handler({}, { hasUI: false });
  const { ui, calls } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: false, ui });
  assert.deepEqual(calls, [], "a session without a UI shows nothing");

  loadBridge(bus);
  assert.deepEqual(surfaceCounts(), ALL_FOUR);

  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });
  assert.deepEqual(calls, [], "the surfaces registered, so the waiting notice is no longer true");
});
