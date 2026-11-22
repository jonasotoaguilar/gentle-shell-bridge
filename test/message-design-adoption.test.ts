/**
 * T3 — the adoption pass: the message Pi already mounted, reached where Pi keeps it.
 *
 * A `CustomMessageComponent` holds the renderer Pi resolved for that message in `customRenderer` and
 * calls it again on every `rebuild()`. Nothing else reaches it: `registerMessageRenderer` writes into
 * the registering extension's own map and the runner answers the first one in load order, so the
 * component is the only capture point there is.
 *
 * This file drives the pass with a component that rebuilds the way Pi's does, so the observable
 * contract is pinned: an unclaimed type is never touched (S4), a host-rendered type keeps its frame
 * and only its rows change (S3), and the switch back to `default` restores the host's own output.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerCardStyle, resetBusForTests } from "../src/bus.ts";
import { setCardStyleSelection } from "../src/card-styles.ts";
import {
  adoptCustomMessages,
  resetMessageDesignAdoptionForTests,
} from "../src/message-design-adoption.ts";
import {
  getMessageDesignFailures,
  registerMessageDesign,
  resetMessageDesignsForTests,
  setMessageDesignSelection,
} from "../src/message-designs.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { MessageDesignRegistration } from "../src/types.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-message-adoption-"));
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
  resetMessageDesignsForTests();
  resetMessageDesignAdoptionForTests();
  resetBusForTests();
  resetStoreStateForTests();
});

const TYPE = "gentle-pi.exploration-budget";
const REMINDER = "gentle-pi.verifier-settle-reminder";

/**
 * The smallest faithful stand-in for Pi's `CustomMessageComponent`: it keeps the renderer it was
 * built with, calls it again on `rebuild()`, and falls back to its own box when the renderer answers
 * `undefined`. `rendererCalls` and `invalidations` are the observable effects of an adoption pass.
 */
interface FakeMessage {
  message: { customType: string; content: string };
  customRenderer: unknown;
  rendererCalls: number;
  invalidations: number;
  rebuilds: number;
  rebuild(): void;
  invalidate(): void;
  render(width: number): readonly string[];
}

function fakeCustomMessage(
  customType: string,
  hostRows?: (message: unknown, options: unknown) => readonly string[],
): FakeMessage {
  const child: FakeMessage = {
    message: { customType, content: "hello" },
    customRenderer:
      hostRows === undefined
        ? undefined
        : (message: unknown, options: unknown) => ({
            render: (width: number): readonly string[] =>
              hostRows(message, options).map((row) => `${row}@${width}`),
          }),
    rendererCalls: 0,
    invalidations: 0,
    rebuilds: 0,
    rebuild(): void {
      child.rebuilds += 1;
    },
    invalidate(): void {
      child.invalidations += 1;
      child.rebuild();
    },
    render(width: number): readonly string[] {
      child.rendererCalls += 1;
      const renderer = child.customRenderer;
      if (typeof renderer === "function") {
        const component = (renderer as (m: unknown, o: unknown, t: unknown) => unknown)(
          child.message,
          { expanded: false, outputPad: 1 },
          {},
        );
        if (component !== undefined) {
          return (component as { render(width: number): readonly string[] }).render(width);
        }
      }
      return [`[${customType}] pi's own box@${width}`];
    },
  };
  return child;
}

const container = (children: unknown[]): { children: unknown[] } => ({ children });

const design = (
  extra: Partial<MessageDesignRegistration> = {},
): MessageDesignRegistration => ({
  customType: TYPE,
  id: "loon.budget",
  label: "budget",
  apply: (lines: readonly string[]) => [...lines, "design row"],
  ...extra,
});

// ---------------------------------------------------------------------------------------------
// S4 — nobody claimed it: the pass is invisible
// ---------------------------------------------------------------------------------------------

test("S4: a message of a type nobody claimed is left exactly as it was", () => {
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  const before = child.customRenderer;

  const result = adoptCustomMessages(container([child]));

  assert.equal(result.scanned, 1);
  assert.equal(result.ignored, 1);
  assert.equal(result.adopted, 0);
  assert.equal(child.customRenderer, before, "the host's renderer, untouched");
  assert.equal(child.invalidations, 0, "and nothing rebuilt: no work, no bytes changed");
});

test("S4: a child that is not a custom message is not ours to touch", () => {
  const stranger = { render: () => ["rows"], toolName: "bash" };
  const result = adoptCustomMessages(container([stranger, 42, null]));

  assert.equal(result.scanned, 3);
  assert.equal(result.ignored, 3);
  assert.equal(result.adopted, 0);
});

test("S4: a container that is not a container is answered, never thrown at", () => {
  for (const notAContainer of [undefined, null, 42, {}, { children: "nope" }]) {
    assert.doesNotThrow(() => adoptCustomMessages(notAContainer));
    assert.equal(adoptCustomMessages(notAContainer).scanned, 0);
  }
});

// ---------------------------------------------------------------------------------------------
// S3 — a host-rendered type: the frame stays, the rows change
// ---------------------------------------------------------------------------------------------

test("S3: the first pass installs the design renderer and rebuilds the message ONCE", () => {
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  registerMessageDesign(design());

  const result = adoptCustomMessages(container([child]));

  assert.equal(result.adopted, 1);
  assert.equal(child.invalidations, 1, "one rebuild, so the stored renderer is re-resolved");
  assert.notEqual(child.customRenderer, undefined, "the design renderer is in place");
});

test("S3: the second pass adopts nothing and rebuilds nothing", () => {
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  registerMessageDesign(design());

  adoptCustomMessages(container([child]));
  const afterFirst = child.customRenderer;
  const result = adoptCustomMessages(container([child]));

  assert.equal(result.already, 1);
  assert.equal(result.adopted, 0);
  assert.equal(child.customRenderer, afterFirst, "the same renderer, not a second wrapper");
  assert.equal(child.invalidations, 1, "and no second rebuild");
});

test("S3: with `default` selected the host's own frame is drawn, byte for byte", () => {
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  registerMessageDesign(design());
  adoptCustomMessages(container([child]));

  assert.deepEqual(child.render(40), ["host frame@40"], "exactly what Pi drew before the bridge");
});

test("S3: a selected design receives the host's rows at the message's width and returns the rest", () => {
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  registerMessageDesign(design());
  setMessageDesignSelection(TYPE, "loon.budget");
  adoptCustomMessages(container([child]));

  assert.deepEqual(child.render(40), ["host frame@40", "design row"]);
  assert.deepEqual(child.render(72), ["host frame@72", "design row"], "the width is read per pass");
});

test("S3: choosing a design AFTER the message was drawn repaints it without a second pass", () => {
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  registerMessageDesign(design());
  adoptCustomMessages(container([child]));
  assert.deepEqual(child.render(40), ["host frame@40"]);

  // The user picks the design: the renderer re-reads the selection on every pass.
  setMessageDesignSelection(TYPE, "loon.budget");
  assert.deepEqual(child.render(40), ["host frame@40", "design row"]);
});

test("S3: going back to `default` restores Pi's own output on the next rebuild", () => {
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  registerMessageDesign(design());
  setMessageDesignSelection(TYPE, "loon.budget");
  adoptCustomMessages(container([child]));
  assert.deepEqual(child.render(40), ["host frame@40", "design row"]);

  // `default` with a host renderer needs no rebuild: the component reads the live selection.
  setMessageDesignSelection(TYPE, "native");
  adoptCustomMessages(container([child]));
  assert.deepEqual(child.render(40), ["host frame@40"]);
});

// ---------------------------------------------------------------------------------------------
// A child the pass cannot adopt is reported, never thrown at
// ---------------------------------------------------------------------------------------------

test("S3: a message whose renderer cannot be replaced is reported and left alone", () => {
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  registerMessageDesign(design());
  Object.defineProperty(child, "customRenderer", {
    get: () => undefined,
    set: () => {
      // A host that refuses the assignment without throwing.
    },
    configurable: true,
  });

  const result = adoptCustomMessages(container([child]));

  assert.equal(result.failed, 1);
  assert.equal(
    getMessageDesignFailures().some((failure) => failure.customType === TYPE),
    true,
    "reported through the design bus's one failure channel",
  );
});

test("S3: `render` on an adopted message answers rows for a host renderer that returns nothing", () => {
  const child = fakeCustomMessage(TYPE);
  registerMessageDesign(design({ apply: () => ["own box"] }));
  setMessageDesignSelection(TYPE, "loon.budget");
  adoptCustomMessages(container([child]));

  assert.deepEqual(child.render(30), ["own box"], "a design without host rows still draws");
});

test("S2: the two motivating types are adopted only when a design claims them", () => {
  const budget = fakeCustomMessage(TYPE);
  const reminder = fakeCustomMessage(REMINDER);
  registerMessageDesign({
    line: "gentle pi",
    types: [TYPE, REMINDER],
    id: "loon.panel",
    label: "panel",
    apply: () => ["panel"],
  });

  const result = adoptCustomMessages(container([budget, reminder]));

  assert.equal(result.adopted, 2, "one line, two messages, one pass");
});

// ---------------------------------------------------------------------------------------------
// S2 — a type with NO host renderer: the design owns the box
// ---------------------------------------------------------------------------------------------

test("S2: the design draws the whole box, and `default` gives Pi's own box back after ONE rebuild", () => {
  // A customType written by an extension that renders nothing: `customRenderer` is undefined, so
  // without a design Pi draws its default `[type]` box. This is the motivating case (S2).
  const child = fakeCustomMessage(REMINDER);
  registerMessageDesign({
    customType: REMINDER,
    id: "loon.reminder",
    label: "reminder",
    apply: () => ["╭─ reminder ─╮", "│ settle    │", "╰───────────╯"],
  });
  setMessageDesignSelection(REMINDER, "loon.reminder");

  adoptCustomMessages(container([child]));
  assert.equal(child.invalidations, 1, "the first adoption rebuilds the message");
  assert.deepEqual(child.render(40), ["╭─ reminder ─╮", "│ settle    │", "╰───────────╯"], "the design owns the box");

  // The user goes back to `default`: the renderer must answer `undefined` again so Pi draws its box,
  // which is a different ANSWER from the same renderer, so exactly one rebuild happens.
  setMessageDesignSelection(REMINDER, "native");
  const pass = adoptCustomMessages(container([child]));
  assert.equal(pass.already, 1);
  assert.equal(child.invalidations, 2, "one more rebuild, never two");
  assert.deepEqual(child.render(40), [`[${REMINDER}] pi's own box@40`], "Pi's box, byte for byte");

  // And back again, still one rebuild per switch.
  setMessageDesignSelection(REMINDER, "loon.reminder");
  adoptCustomMessages(container([child]));
  assert.equal(child.invalidations, 3);
  assert.deepEqual(child.render(40)[0], "╭─ reminder ─╮");
});

test("S2: the design reads `ctx.cardStyle`, so the consumer's painter knows which frame to draw", () => {
  registerCardStyle({
    id: "loon.lunar",
    label: "lunar",
    frame: {
      top: () => "top",
      line: (line) => line.text,
      bottom: () => "bottom",
    },
  });
  setCardStyleSelection("loon.lunar");

  let seen: unknown;
  const child = fakeCustomMessage(REMINDER);
  registerMessageDesign({
    customType: REMINDER,
    id: "loon.reminder",
    label: "reminder",
    apply: (lines: readonly string[], ctx) => {
      seen = ctx.cardStyle;
      return [`painted ${lines.length}`];
    },
  });
  setMessageDesignSelection(REMINDER, "loon.reminder");

  adoptCustomMessages(container([child]));
  assert.deepEqual(child.render(40), ["painted 0"], "no host rows: the design draws from the message");
  const style = seen as { kind: string; style?: { id: string } };
  assert.equal(style.kind, "style", "the bridge's own Card style selection, the one a tool design reads");
  assert.equal(style.style?.id, "loon.lunar", "and the exact style the user chose");
});
