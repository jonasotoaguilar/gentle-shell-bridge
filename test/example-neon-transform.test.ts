/**
 * L5: the example's `Bash rendering` toggle against a `neon` bash card.
 *
 * The user's frame, in a real TUI: the host's own `Card style` line is on `neon`, the content is
 * minimal, and the example's `Bash rendering` is on `tool` — and the card keeps its neon outline.
 * The pipeline and the bridge are not the cause (the bridge's repaint is `float`-only, so a neon
 * frame reaches the transform untouched); the example's grammar only knew the host's `float` frame
 * and its own `plain` one. These tests exercise the REAL example through the real bridge entry, the
 * way `test/example-transform.test.ts` does for `float`/`plain`, and pin the third shape.
 *
 * The frames are host-derived fixtures (`test/fake-transcript.ts`: `NEON_BASH_CARD*`, built from
 * `gentle-shell/lib/shell-card.ts` — `cardTop`/`cardLine`/`cardBottom` with the frame role `90` and
 * the title role `95`). They are not read off a screenshot, and this unit does not observe a live
 * TUI: what is proven here is the example's grammar and the toggle, not the terminal.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishBridgeApi, resetBridgeApiForTests } from "../src/api.ts";
import {
  resetBusForTests,
  resetCardStylesForTests,
  resetSectionsForTests,
  resetTransformsForTests,
  snapshotProviders,
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
import {
  NEON_BASH_CARD,
  NEON_BASH_CARD_WITH_BODY,
  NEON_BASH_CARD_WITH_HINT,
  NEON_CARD,
  createFakeTranscriptTui,
  type FakeTui,
} from "./fake-transcript.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-example-neon-"));
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
  // The bridge repaints nothing: the neon frame is the HOST's own style, which is the state L5
  // reports. A `float`-only repaint could not produce or recognise it, and must not be blamed.
  setCardStyleSelection("native");
});

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
  /** A later frame: the host redraws its conversation. */
  revealHostFrame(lines: readonly string[]): void;
  setMode(mode: Mode): void;
  dispose(): void;
}

/**
 * A whole session as Pi runs it: the bridge arms itself through `ctx.ui.setWidget`, the example
 * registers from its own `session_start`, and the conversation component returns ONE cached array,
 * so "the same card, restyled" is observable rather than asserted.
 */
async function startWorld(tag: string, frame: readonly string[]): Promise<World> {
  publishBridgeApi();
  const tui = createFakeTranscriptTui({ lines: [...frame] });
  let hostFrame: string[] = [...frame];
  let cached: string[] | undefined;
  tui.chat.render = (): string[] => (cached ??= [...hostFrame]);

  const sessionHandlers: SessionHandler[] = [];
  const init = await loadExample(tag);
  const dispose = init({
    on(_event, handler) {
      sessionHandlers.push(handler);
    },
    registerToolRenderer() {},
  });
  const ui = {
    notify() {},
    setWidget: (_key: string, factory: (tuiArg: unknown, theme: unknown) => unknown) =>
      factory(tui, {}),
  };

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
  };
}

// ---------------------------------------------------------------------------------------------
// C1, C5: the same toggle, both directions, on a card already drawn
// ---------------------------------------------------------------------------------------------

test("`tool` restyles a neon bash card already on screen, and `default` restores the host's array", async () => {
  const frame = ["a line the host wrote", "", ...NEON_BASH_CARD];
  const world = await startWorld("neon-minimal", frame);

  const before = world.tui.chat.render(40);

  assert.equal(before, world.hostLines(), "`default` is the host's own array, untouched");
  assert.deepEqual([...world.hostLines()], [...frame], "and the host's rows are its own");

  world.setMode("tool");
  const restyled = world.tui.chat.render(40);

  assert.deepEqual(
    restyled,
    ["a line the host wrote", "", "▸ bash", "▸"],
    "the neon card already on screen carries the example's chrome, bodyless as it was",
  );
  assert.notEqual(restyled, before, "a new frame was produced, not the host's array mutated");
  assert.deepEqual([...world.hostLines()], [...frame], "the host's own array was never rewritten");

  world.setMode("default");
  const restored = world.tui.chat.render(40);

  assert.equal(restored, world.hostLines(), "`default` restores the host's identical array");
  assert.deepEqual([...restored], [...frame]);

  world.dispose();
});

// ---------------------------------------------------------------------------------------------
// C2: the neon body is the body, the rails and the hint are frame
// ---------------------------------------------------------------------------------------------

test("a neon body row survives as the card's body, without its rails or padding", async () => {
  const world = await startWorld("neon-body", ["prose", "", ...NEON_BASH_CARD_WITH_BODY]);

  world.setMode("tool");
  const output = world.tui.chat.render(40);

  assert.deepEqual(output, ["prose", "", "▸ bash", "▸ ls -1", "▸"]);
  world.dispose();
});

test("a right-aligned hint on the neon top rule is frame, never body text", async () => {
  const world = await startWorld("neon-hint", ["prose", "", ...NEON_BASH_CARD_WITH_HINT]);

  world.setMode("tool");
  const output = world.tui.chat.render(40);

  assert.deepEqual(output, ["prose", "", "▸ bash", "▸ ls -1", "▸"]);
  world.dispose();
});

// ---------------------------------------------------------------------------------------------
// C4: another neon card is the host's
// ---------------------------------------------------------------------------------------------

test("a `neon` read card beside the bash one is carried through byte-identically", async () => {
  const world = await startWorld("neon-read", ["prose", "", ...NEON_CARD, "", ...NEON_BASH_CARD]);

  world.setMode("tool");
  const output = world.tui.chat.render(40);

  assert.deepEqual(output.slice(2, 5), [...NEON_CARD], "the read card is not bash: untouched");
  assert.deepEqual(output.slice(6), ["▸ bash", "▸"], "and the bash card is the example's");
  world.dispose();
});

// ---------------------------------------------------------------------------------------------
// C3: anything that is not a complete neon bash card is left alone
// ---------------------------------------------------------------------------------------------

test("an incomplete neon card, or a neon card that is not bash, is the same array in `tool` mode", async () => {
  const tipOnly = [NEON_BASH_CARD[0]];
  const world = await startWorld("neon-incomplete", ["prose", "", ...tipOnly]);
  world.setMode("tool");

  const unterminated = world.tui.chat.render(40);
  assert.equal(unterminated, world.hostLines(), "an unterminated card is not a card");
  assert.deepEqual([...unterminated], ["prose", "", ...tipOnly]);

  const railLess = [
    NEON_BASH_CARD[0],
    "\u001b[90m│\u001b[39m \u001b[39mls -1\u001b[39m",
  ];
  world.revealHostFrame(railLess);
  const broken = world.tui.chat.render(40);
  assert.equal(broken, world.hostLines(), "a row without the side rail is not a body row");
  assert.deepEqual([...broken], [...railLess]);

  world.revealHostFrame([...NEON_CARD]);
  const notBash = world.tui.chat.render(40);
  assert.equal(notBash, world.hostLines(), "a complete neon card that is not bash is untouched");
  assert.deepEqual([...notBash], [...NEON_CARD]);

  world.dispose();
});

test("a neon top rule with no closing corner is not a frame, even when rows below look like one", async () => {
  // The host always closes its top rule with `╮` (`cardTop`, `shell-card.ts:139-160`). A row that
  // merely STARTS like a top rule is not a card, and the rows under it are not its body.
  const noCorner =
    "\u001b[90m╭\u001b[39m\u001b[90m─ \u001b[39m\u001b[95m✿ bash\u001b[39m" +
    "\u001b[90m ─────────────────────────────\u001b[39m";
  const frame = ["prose", "", noCorner, ...NEON_BASH_CARD_WITH_BODY.slice(1)];
  const world = await startWorld("neon-no-corner", frame);

  world.setMode("tool");
  const output = world.tui.chat.render(40);

  assert.equal(output, world.hostLines(), "an incomplete top rule is not a bash card");
  assert.deepEqual([...output], [...frame], "every row is the host's, byte for byte");

  world.dispose();
});

// ---------------------------------------------------------------------------------------------
// C5: the shape is visible in `/bridge-status`
// ---------------------------------------------------------------------------------------------

test("the frame that restyled the neon card reports the `neon` shape", async () => {
  const world = await startWorld("neon-telemetry", ["prose", "", ...NEON_BASH_CARD]);

  world.setMode("tool");
  world.tui.chat.render(40);

  const line = formatStatus(collectStatus()).find((candidate) =>
    candidate.startsWith("  - bash-card-example.bash-cards"),
  );
  assert.equal(
    line,
    "  - bash-card-example.bash-cards (order 10): applied, 4 lines, 1 candidate, " +
      "1 recognised, 1 rewritten, shapes: neon 1",
    "recognition names the shape that matched, so the next report is data-driven",
  );

  world.dispose();
});
