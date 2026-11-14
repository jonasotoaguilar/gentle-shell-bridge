/**
 * The worked example's `Bash rendering` toggle, end to end (S6).
 *
 * This is the harness for the defect that started the feature: switching the toggle used to restyle
 * only bash cards built AFTER the switch, because `pi.registerToolRenderer` resolves when a row is
 * built. Here the example registers a TRANSFORM instead, the real bridge entry wraps a fake
 * conversation component, and the SAME host array — drawn once, never rebuilt — is restyled when
 * the toggle moves to `tool` and comes back untouched when it moves to `default`.
 *
 * The example's `plain` card style is exercised on both cards of the frame, so "one style for tool
 * cards in general" is proven rather than asserted: a `read` card is repainted too, not only bash.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BRIDGE_API_KEY,
  bridgeApi,
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
import { resetCardStyleTransformForTests } from "../src/card-style-transform.ts";
import { disableCardStyleTransform, resetCardStyleWiringForTests } from "../src/card-style-wiring.ts";
import { setCardStyleSelection } from "../src/card-styles.ts";
import { disableCaptureBackend, resetCaptureStateForTests } from "../src/capture.ts";
import gentleShellBridge, {
  type BridgeExtensionApi,
  type BridgeSessionHandler,
} from "../src/extension.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import { disableSidebarBackend, resetSidebarStateForTests } from "../src/sidebar.ts";
import { resetSectionFailuresForTests } from "../src/sidebar-render.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import { resetTransformPipelineForTests } from "../src/transform-pipeline.ts";
import type { CustomizeRow, InlineHelpers } from "../src/types.ts";
import { READ_CARD, createFakeTranscriptTui, type FakeTui } from "./fake-transcript.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-example-transform-"));
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
  resetCardStylesForTests();
  resetTransformsForTests();
  resetTransformPipelineForTests();
  resetCardStyleTransformForTests();
  resetCardStyleWiringForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetRowBuildStateForTests();
  resetSidebarStateForTests();
  resetSectionFailuresForTests();
  resetNoticesForTests();
  resetStoreStateForTests();
  disableCaptureBackend();
  disableSidebarBackend();
  disableCardStyleTransform();
  setCardStyleSelection("native");
});

/** `READ_CARD` is a float card titled `read` with the body `config.ts`; this is the bash one. */
const BASH_CARD: readonly string[] = READ_CARD.map((line) =>
  line.replace("✿ read", "✿ bash").replace("config.ts", "ls -1"),
);

/** Prose, a `read` tool card and a `bash` tool card: both tools, one frame. */
const FRAME: readonly string[] = [
  "a line the host wrote",
  "",
  ...READ_CARD,
  "",
  ...BASH_CARD,
];

type SessionHandler = (event: unknown, ctx: { hasUI?: boolean; ui?: unknown }) => void;

interface FakePi {
  on?: (event: string, handler: SessionHandler) => void;
  registerToolRenderer?: (resolver: unknown) => void;
}

type ExampleInit = (pi: FakePi) => () => void;

const loadExample = async (tag: string): Promise<ExampleInit> => {
  const specifier = new URL(`../examples/bash-card.ts?${tag}`, import.meta.url).href;
  return ((await import(specifier)) as { default: ExampleInit }).default;
};

const inlineHelpers: InlineHelpers = {
  input: async () => undefined,
  confirm: async () => true,
  capture: async () => undefined,
};

type Mode = "default" | "tool";

interface World {
  tui: FakeTui;
  /** The one array the host's conversation component produced, before any transform ran. */
  hostLines: () => readonly string[];
  /** A later frame: the host redraws its conversation, as it does when a new tool row arrives. */
  revealHostFrame(lines: readonly string[]): void;
  setMode(mode: Mode): void;
  dispose(): void;
  notices: string[];
  rendererRegistrations: () => number;
}

const hostSlot = (): Record<symbol, unknown> => globalThis as unknown as Record<symbol, unknown>;

/**
 * A whole session, the way Pi runs it: the bridge arms itself through `ctx.ui.setWidget` (the only
 * way in), the example registers from its own `session_start` handler, and the conversation
 * component returns ONE cached array so "the same array, restyled" is observable.
 */
async function startWorld(tag: string, frame: readonly string[] = FRAME): Promise<World> {
  publishBridgeApi();
  const tui = createFakeTranscriptTui({ lines: [...frame] });
  let hostFrame: string[] = [...frame];
  let cached: string[] | undefined;
  // The host's conversation component: ONE array per draw, and a new draw when its content grows.
  tui.chat.render = (): string[] => (cached ??= [...hostFrame]);

  const notices: string[] = [];
  const sessionHandlers: SessionHandler[] = [];
  let rendererRegistrations = 0;
  const pi: FakePi = {
    on(_event, handler) {
      sessionHandlers.push(handler);
    },
    registerToolRenderer() {
      rendererRegistrations += 1;
    },
  };

  const init = await loadExample(tag);
  const dispose = init(pi);
  const ui = {
    notify: (message: string) => notices.push(message),
    setWidget: (_key: string, factory: (tuiArg: unknown, theme: unknown) => unknown) => factory(tui, {}),
  };

  // The bridge itself, loaded and armed through its real entry: `session_start` is where
  // `armSidebar` installs the conversation wrapper the pipeline runs in.
  const bridgeSessions: BridgeSessionHandler[] = [];
  const bridgeExtension: BridgeExtensionApi = {
    on(_event, handler) {
      bridgeSessions.push(handler);
    },
    registerCommand() {},
  };
  gentleShellBridge(bridgeExtension);
  for (const handler of bridgeSessions) handler({}, { hasUI: true, ui });
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });

  const provider = snapshotProviders().find(
    (registered) => registered.id === "bash-card-example.rendering",
  );
  assert.ok(provider !== undefined, "the example's toggle registered itself");

  const press = (mode: Mode): void => {
    const row: CustomizeRow | undefined = provider.rows({ theme: undefined, configHome }).find(
      (candidate) => candidate.choice?.value === mode,
    );
    assert.ok(row?.action !== undefined, `the ${mode} row must have an action`);
    row.action(inlineHelpers);
  };

  return {
    tui,
    hostLines: () => cached ?? [],
    revealHostFrame: (lines) => {
      hostFrame = [...lines];
      cached = undefined;
    },
    setMode: press,
    dispose,
    notices,
    rendererRegistrations: () => rendererRegistrations,
  };
}

// ---------------------------------------------------------------------------------------------
// The defect: a switch that only applies to the NEXT card
// ---------------------------------------------------------------------------------------------

test("switching to `tool` restyles the bash cards already on screen, and back to `default` restores them", async () => {
  const world = await startWorld("defect");
  const before = world.tui.chat.render(40);

  assert.equal(before, world.hostLines(), "`default` is the host's own array, untouched");
  assert.deepEqual([...world.hostLines()], [...FRAME], "and the host's rows are its own");

  world.setMode("tool");
  const restyled = world.tui.chat.render(40);

  assert.deepEqual(
    restyled,
    [
      "a line the host wrote",
      "",
      ...READ_CARD, // a `read` card is not bash: untouched
      "",
      "▸ bash",
      "▸ ls -1",
      "▸",
    ],
    "the bash card already on screen carries the example's chrome",
  );
  assert.notEqual(restyled, before, "a new frame was produced, not the host's array mutated");
  assert.deepEqual([...world.hostLines()], [...FRAME], "the host's own array was never rewritten");

  world.setMode("default");
  const restored = world.tui.chat.render(40);

  assert.equal(restored, world.hostLines(), "`default` restores the host's identical array");
  assert.deepEqual([...restored], [...FRAME]);

  world.dispose();
});

test("`default` keeps a host frame with hyperlinks and wide graphemes byte-identical (L3)", async () => {
  const world = await startWorld("host-protocol-rows");
  const href = (url: string, text: string): string => `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`;
  const rows = [
    `\u001b[48;5;236m${href("file:///tmp/config.ts", "config.ts")}${" ".repeat(30)}\u001b[0m`,
    `\u001b[48;5;236mread this file: 👨‍👩‍👧‍👦 now${" ".repeat(18)}\u001b[0m`,
  ];
  world.revealHostFrame(rows);

  const output = world.tui.chat.render(40);

  assert.equal(output, world.hostLines(), "the host's own array, not a clipped copy");
  assert.deepEqual(output, rows, "not one byte of the host's rows changed");

  world.dispose();
});

test("a bash card built later looks exactly like the one that was already there", async () => {
  const world = await startWorld("past-and-new");
  world.setMode("tool");
  const pastCard = world.tui.chat.render(40).slice(8);

  // A LATER frame: the host redraws its conversation, now with a freshly built bash card.
  world.revealHostFrame([...FRAME, "", ...BASH_CARD]);
  const newCard = world.tui.chat.render(40).slice(-3);

  assert.deepEqual(newCard, pastCard, "past and new are byte-identical: one owner, one chrome");
  assert.deepEqual(pastCard, ["▸ bash", "▸ ls -1", "▸"]);

  world.dispose();
});

// ---------------------------------------------------------------------------------------------
// One card style for tool cards in general
// ---------------------------------------------------------------------------------------------

test("`plain` is registered as a card style and repaints every tool card, not only bash", async () => {
  const world = await startWorld("plain");

  assert.ok(
    snapshotCardStyles().some((style) => style.id === "bash-card.plain" && style.label === "plain"),
    "the example registers `plain` on the host's own line",
  );

  setCardStyleSelection("bash-card.plain");
  const output = world.tui.chat.render(40);

  assert.equal(output.length, 9, "every host row survived the repaint");
  assert.ok(output[2]?.startsWith("▌ read"), "the read card was repainted too");
  assert.ok(output[2]?.endsWith("ctrl+o"), "and kept its hint");
  assert.equal(output[3], "▌ config.ts");
  assert.equal(output[4], "▌");
  assert.ok(output[6]?.startsWith("▌ bash"), "the bash card is the same frame");
  assert.equal(output[7], "▌ ls -1");
  assert.equal(output[8], "▌");

  world.dispose();
});

test("with `tool` selected the bash card wins over `plain` and the other tools keep the card style", async () => {
  const world = await startWorld("plain-and-tool");
  setCardStyleSelection("bash-card.plain");
  world.setMode("tool");

  const output = world.tui.chat.render(40);

  assert.equal(output.length, 9);
  assert.ok(output[2]?.startsWith("▌ read") && output[2]?.endsWith("ctrl+o"));
  assert.equal(output[3], "▌ config.ts");
  assert.equal(output[4], "▌");
  assert.deepEqual(output.slice(6), ["▸ bash", "▸ ls -1", "▸"]);

  world.dispose();
});

// ---------------------------------------------------------------------------------------------
// The surface it registers, and the bridge it needs
// ---------------------------------------------------------------------------------------------

test("the example claims no tool renderer: the transform is the single owner", async () => {
  const world = await startWorld("no-resolver");

  assert.equal(
    world.rendererRegistrations(),
    0,
    "nothing is registered through pi.registerToolRenderer",
  );
  assert.deepEqual(
    snapshotTransforms().map((transform) => transform.id),
    ["bash-card-example.bash-cards"],
    "the toggle's rendering is one transform",
  );
  assert.deepEqual(world.notices, [], "and nothing had to be reported");

  world.dispose();
});

test("the disposer the example returns removes its transform along with the other surfaces", async () => {
  const world = await startWorld("dispose-transform");
  assert.equal(snapshotTransforms().length, 1);
  assert.ok(snapshotSections().some((section) => section.id === "bash-card.status"));

  world.dispose();

  assert.deepEqual(snapshotTransforms(), []);
  assert.equal(
    snapshotProviders().some((provider) => provider.id === "bash-card-example.rendering"),
    false,
    "the example's toggle is gone",
  );
  assert.deepEqual(snapshotSections(), []);
  assert.deepEqual(snapshotCardStyles(), []);
});

test("an older bridge object without registerTransform keeps the rows, the section and the card style", async () => {
  const published = bridgeApi() ?? publishBridgeApi();
  // First-wins: the object a mixed process hands back can predate this surface. Put one there.
  hostSlot()[BRIDGE_API_KEY] = {
    schema: published.schema,
    version: published.version,
    VERSION: published.VERSION,
    registerRows: published.registerRows,
    registerSection: published.registerSection,
    registerCardStyle: published.registerCardStyle,
    createStore: published.createStore,
  };

  const tui = createFakeTranscriptTui({ lines: [...FRAME] });
  const notices: string[] = [];
  const sessionHandlers: SessionHandler[] = [];
  const init = await loadExample("old-object");
  const dispose = init({
    on(_event, handler) {
      sessionHandlers.push(handler);
    },
    registerToolRenderer() {},
  });
  const ui = {
    notify: (message: string) => notices.push(message),
    setWidget: (_key: string, factory: (tuiArg: unknown, theme: unknown) => unknown) => factory(tui, {}),
  };
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });

  assert.deepEqual(notices, [], "a surface the bridge never promised is not warned about");
  assert.deepEqual(snapshotTransforms(), [], "the missing surface is simply not used");
  assert.ok(snapshotProviders().some((row) => row.id === "bash-card-example.rendering"));
  assert.ok(snapshotCardStyles().some((style) => style.id === "bash-card.plain"));

  dispose();
});

test("`/bridge-status` reports the example's transform and what the last frame did with it", async () => {
  const world = await startWorld("status");
  world.setMode("tool");
  world.tui.chat.render(40);

  let lines = formatStatus(collectStatus());
  assert.ok(lines.includes("transforms: 1 registered"));
  assert.ok(
    lines.includes(
      "  - bash-card-example.bash-cards (order 10): applied, 13 lines, 4 candidates, " +
        "1 recognised, 1 rewritten, shapes: float 1",
    ),
    "the frame that restyled the card is reported, with what its grammar saw",
  );

  world.setMode("default");
  world.tui.chat.render(40);

  lines = formatStatus(collectStatus());
  assert.ok(
    lines.includes(
      "  - bash-card-example.bash-cards (order 10): skipped, 13 lines, 4 candidates, " +
        "1 recognised, 0 rewritten, shapes: float 1",
    ),
    "and a frame with nothing to do says so, and still names what it recognised",
  );

  world.dispose();
});

// ---------------------------------------------------------------------------------------------
// F3 — the example's own recognition is visible in the report
// ---------------------------------------------------------------------------------------------

test("the example's grammar reports what it examined, recognised and rewrote, by shape", async () => {
  const world = await startWorld("telemetry");

  world.tui.chat.render(40); // `default`: the cards stay the host's, the grammar still looks
  let line = formatStatus(collectStatus()).find((candidate) =>
    candidate.startsWith("  - bash-card-example.bash-cards"),
  );
  assert.equal(
    line,
    "  - bash-card-example.bash-cards (order 10): skipped, 13 lines, 4 candidates, " +
      "1 recognised, 0 rewritten, shapes: float 1",
    "recognition is reported even when the setting leaves every card alone",
  );

  world.setMode("tool");
  world.tui.chat.render(40);
  line = formatStatus(collectStatus()).find((candidate) =>
    candidate.startsWith("  - bash-card-example.bash-cards"),
  );
  assert.equal(
    line,
    "  - bash-card-example.bash-cards (order 10): applied, 13 lines, 4 candidates, " +
      "1 recognised, 1 rewritten, shapes: float 1",
    "and a rewrite is counted separately from the recognition that allowed it",
  );
  assert.equal(line?.includes("ls -1"), false, "no line of the frame reaches the report");

  world.dispose();
});

test("a frame with no bash card reports candidates and no recognition, which is the whole point", async () => {
  const world = await startWorld("telemetry-miss");

  // A frame with a `read` card only: the float grammar is examined and nothing matches it. This is
  // the answer "the pipeline reached the conversation, the grammar did not recognise a card".
  world.revealHostFrame(["a line the host wrote", "", ...READ_CARD]);
  world.setMode("tool");
  world.tui.chat.render(40);

  const line = formatStatus(collectStatus()).find((candidate) =>
    candidate.startsWith("  - bash-card-example.bash-cards"),
  );
  assert.equal(
    line,
    "  - bash-card-example.bash-cards (order 10): skipped, 7 lines, 3 candidates, " +
      "0 recognised, 0 rewritten",
    "a miss is visible as candidates without recognition",
  );

  world.dispose();
});
