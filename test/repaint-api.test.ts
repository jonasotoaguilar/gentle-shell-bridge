/**
 * The plugin-facing full repaint (T4 of `odd/tasks/bash-card-identity.md`): choosing a frame for the
 * cards already on screen, not only the next one.
 *
 * `requestSurfaceRepaint` (`./repaint.ts`) asks for a frame with no argument, and the host's own
 * per-component frame caches — `ToolCardRows` in `cards-bash-v2` `extensions/quiet-tools.ts:926-966`
 * — hand back the rows they drew under the previous preference, so a setting change repaints the
 * chrome and not the card. `requestRepaint()` therefore drops those caches first
 * (`tui.invalidate()`, `pi-tui/dist/tui.js:585-590`) and then asks for a frame the renderer cannot
 * dedupe away (`requestRender(force = true)`, `tui.js:658-663`).
 *
 * Everything asserted here is the order and the arguments the host actually observes, plus the
 * `/bridge-status` record: no timers, no internal fields.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { bridgeApi } from "../src/api.ts";
import {
  getRepaintDiagnostics,
  requestRepaint,
  requestSurfaceRepaint,
  resetRepaintForTests,
  setRepaintHost,
} from "../src/repaint.ts";

interface HostCall {
  readonly name: "invalidate" | "requestRender";
  readonly args: readonly unknown[];
}

/**
 * The `tui` a host hands the widget factory, as far as a repaint reads it: `invalidate()` and
 * `requestRender(force?)`, recorded in the order the bridge calls them.
 */
function recordingTui(options: { invalidate?: "present" | "absent" | "throws" } = {}): {
  calls: HostCall[];
  requestRenderCalls: () => number;
  host: Record<string, unknown>;
} {
  const calls: HostCall[] = [];
  const mode = options.invalidate ?? "present";
  const host: Record<string, unknown> = {
    terminal: {},
    requestRender(force?: boolean): void {
      calls.push({ name: "requestRender", args: force === undefined ? [] : [force] });
    },
  };
  if (mode === "present") {
    host.invalidate = (): void => {
      calls.push({ name: "invalidate", args: [] });
    };
  }
  if (mode === "throws") {
    host.invalidate = (): void => {
      calls.push({ name: "invalidate", args: [] });
      throw new Error("this component refused to drop its frame");
    };
  }
  return {
    calls,
    requestRenderCalls: () => calls.filter((call) => call.name === "requestRender").length,
    host,
  };
}

test.beforeEach(() => {
  resetRepaintForTests();
});

test("T4: requestRepaint drops the component frame caches, then asks for a forced frame", () => {
  const tui = recordingTui();
  setRepaintHost(tui.host);

  const trigger = requestRepaint();

  assert.deepEqual(
    tui.calls.map((call) => call.name),
    ["invalidate", "requestRender"],
    "the invalidation comes first, so the forced frame is drawn from dropped caches",
  );
  assert.deepEqual(tui.calls[1]?.args, [true], "the frame is forced, not deduped by the renderer");
  assert.deepEqual(trigger, {
    cause: "a plugin asked for a full repaint",
    surfaces: ["conversation", "rail"],
    outcome: "repainted",
  });
  assert.deepEqual(getRepaintDiagnostics().lastTrigger, trigger);
});

test("T4: the bridge-owned path reuses the same forced repaint", () => {
  const tui = recordingTui();
  setRepaintHost(tui.host);

  const trigger = requestSurfaceRepaint({ cause: "card style → neon", surfaces: ["conversation"] });

  assert.deepEqual(tui.calls.map((call) => call.name), ["invalidate", "requestRender"]);
  assert.deepEqual(tui.calls[1]?.args, [true]);
  assert.deepEqual(trigger, {
    cause: "card style → neon",
    surfaces: ["conversation"],
    outcome: "repainted",
  });
});

test("T4: with no host captured the request is reported, not thrown", () => {
  const trigger = requestRepaint();

  assert.deepEqual(trigger, {
    cause: "a plugin asked for a full repaint",
    surfaces: ["conversation", "rail"],
    outcome: "unavailable",
    reason: "no tui has been captured, so no surface can be repainted",
  });
  assert.equal(getRepaintDiagnostics().hostCaptured, false);
  assert.deepEqual(getRepaintDiagnostics().lastTrigger, trigger);
});

test("T4: a captured host without invalidate still gets the forced frame, and a throw is contained", () => {
  const bare = recordingTui({ invalidate: "absent" });
  setRepaintHost(bare.host);
  assert.equal(requestRepaint().outcome, "repainted");
  assert.deepEqual(bare.calls.map((call) => call.name), ["requestRender"], "nothing to invalidate");
  assert.deepEqual(bare.calls[0]?.args, [true]);

  resetRepaintForTests();
  const hostile = recordingTui({ invalidate: "throws" });
  setRepaintHost(hostile.host);
  assert.equal(requestRepaint().outcome, "repainted", "a refused cache is not a failed frame");
  assert.deepEqual(hostile.calls.map((call) => call.name), ["invalidate", "requestRender"]);
  assert.deepEqual(hostile.calls[1]?.args, [true]);
});

test("T4: a captured object with no requestRender() is reported as unavailable", () => {
  setRepaintHost({ terminal: {}, invalidate: () => {} });

  const trigger = requestRepaint();

  assert.equal(trigger.outcome, "unavailable");
  assert.equal(
    trigger.reason,
    "the captured tui has no requestRender(), so no frame can be asked for",
  );
});

test("T4: the published bridge API carries requestRepaint for a plugin that never imports this package", () => {
  const tui = recordingTui();
  setRepaintHost(tui.host);

  const api = bridgeApi();
  assert.equal(typeof api?.requestRepaint, "function", "the plugin-facing slot publishes it");
  api?.requestRepaint?.();

  assert.deepEqual(tui.calls.map((call) => call.name), ["invalidate", "requestRender"]);
  assert.deepEqual(tui.calls[1]?.args, [true]);
  assert.equal(getRepaintDiagnostics().lastTrigger?.outcome, "repainted");
});
