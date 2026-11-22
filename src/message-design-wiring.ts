/**
 * The ONE renderer policy for a custom message somebody claimed with a design (S2, S3, S4).
 *
 * ## What Pi lets an extension do here, and what it does not
 *
 * `pi.registerMessageRenderer(customType, renderer)` writes into THAT extension's own map
 * (`dist/core/extensions/loader.js:284-287`), and the runner answers `getMessageRenderer(customType)`
 * by scanning the loaded extensions in LOAD ORDER and returning the first one that has the type
 * (`dist/core/extensions/runner.js:534-540`). There is no `next()` chain, unlike tool renderers
 * (`:550-553`), and no way to read or wrap another extension's renderer. So "patching
 * `pi.registerMessageRenderer`" cannot capture anybody: every extension holds its own `pi` object
 * with its own closure, and only a registration made THROUGH the bridge's object would pass here.
 *
 * What Pi does expose is the component: `CustomMessageComponent` keeps the renderer Pi resolved for
 * that message in `customRenderer`, and calls it again on every `rebuild()`
 * (`dist/modes/interactive/components/custom-message.js`). That is the capture point, and
 * `./message-design-adoption.ts` is the pass that reaches it. This module is the RULE that pass
 * installs — small enough to assert with no host at all.
 *
 * ## The rule: the host draws the frame, the design rewrites rows
 *
 * ```
 * Pi rebuild() → our renderer → host renderer(message, options, theme) → host component
 *              → [live selection] → design.apply(host rows, ctx) → rows
 * ```
 *
 * The host's renderer runs FIRST and is the only source of the frame, so `float` stays `float` and
 * `neon` stays `neon`: the design never sees a byte of the chrome, only the rows it can rewrite
 * (S3). When the type has no host renderer at all, there is no frame to preserve and the design owns
 * the box (S2): it receives no rows and draws the whole message, `ctx.render.message` in hand.
 *
 * ## The decision is live, the escape hatch is Pi's own
 *
 * Pi captures the renderer once, when the message is added, and re-invokes it on every rebuild. So
 * the decision cannot live in the renderer alone: the component this module returns re-reads the
 * selection on EVERY render pass, which is what lets a design chosen after the message was drawn
 * repaint it, and what makes `default` restore the host's own rows untouched.
 *
 * ## The content level is the design's, not the bridge's
 *
 * Pi's card content level (`minimal`) clips TOOL cards, because the host's own renderer decides how
 * much of a tool result to show, and gentle-shell's renderers offer `previewRows` for exactly that.
 * A custom message has no host renderer, and the bridge adds no policy of its own: it never truncates,
 * re-wraps or withholds a row a design returned, and it never reads a content level. An alert the
 * agent must read in full can therefore print in full — that choice is the DESIGN's, and what this
 * module owes it is the material to make it: `width`, `render.expanded`, `render.outputPad`,
 * `render.message` and `cardStyle`.
 *
 * With nothing selected — `native`, a design that was disposed (`missing`), a line whose selected
 * design never claimed this type (`not-covered`) — the answer is the host's own component, BY
 * IDENTITY, or `undefined` when there is none, which is exactly what makes Pi draw its default box.
 * That is S4's byte-stability: a type nobody claimed never reaches this module at all.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { resolveCardStyleSelection } from "./card-styles.ts";
import {
  applyMessageDesign,
  recordMessageDesignFailure,
  resolveMessageDesignSelection,
  type MessageDesignSelection,
} from "./message-designs.ts";
import { isRecord } from "./rows.ts";
import type { CardStyleSelection, MessageDesignContext, MessageDesignRender } from "./types.ts";

/** The component Pi mounts for a message: `render` plus whatever else this module leaves alone. */
export interface MessageComponentLike {
  render(width: number): readonly string[];
  invalidate?(): void;
  [member: string]: unknown;
}

/**
 * Pi's `MessageRenderer`, described structurally (`dist/core/extensions/types.d.ts:1211`): it is
 * handed the message, `{ expanded, outputPad }` and the theme, and answers a component or
 * `undefined`. The bridge never re-types the host's objects, it forwards them.
 */
export type HostMessageRenderer = (
  message: unknown,
  options: unknown,
  theme?: unknown,
) => unknown;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A by-value snapshot of Pi's render options, plus the message BY REFERENCE (exactly like a tool
 * design's `render.args`): Pi keeps it live, so a design reads it per pass and never caches it.
 * Read inside Pi's render loop, so a host object whose accessors throw yields Pi's own defaults
 * instead of a throw into the frame.
 */
function snapshotRender(message: unknown, options: unknown): MessageDesignRender {
  let expanded = false;
  let outputPad = 1;
  try {
    if (isRecord(options)) {
      if (typeof options.expanded === "boolean") expanded = options.expanded;
      if (typeof options.outputPad === "number" && Number.isFinite(options.outputPad)) {
        outputPad = options.outputPad;
      }
    }
  } catch {
    // A throwing accessor has no options this module can read; Pi's defaults are the answer.
  }
  return { expanded, outputPad, message };
}

/** The live selection, with a registry that refuses to answer treated as "the host's own output". */
function selectionFor(customType: string): MessageDesignSelection {
  try {
    return resolveMessageDesignSelection(customType);
  } catch (error) {
    recordMessageDesignFailure(customType, "(selection)", errorMessage(error));
    return { kind: "native" };
  }
}

/**
 * The rows the host's component draws at this width, or `undefined` when it drew none: a component
 * with no `render`, a `render` that answers something that is not a row array, or no component at
 * all. Always `undefined`-safe, because this runs inside Pi's render loop.
 */
function hostRows(component: unknown, width: number, customType: string): string[] | undefined {
  if (!isRecord(component) || typeof component.render !== "function") return undefined;
  let rows: unknown;
  try {
    // SAFETY: `typeof` just proved `render` callable, and a component's own `render(width)` is the
    // contract this module reads; its answer is inspected before it is trusted.
    rows = (component.render as (width: number) => unknown).call(component, width);
  } catch (error) {
    // The host's own component failing is the host's failure, not the design's: it is reported and
    // the design gets no rows, which draws the message without the frame rather than not at all.
    recordMessageDesignFailure(customType, "(host render)", errorMessage(error));
    return undefined;
  }
  if (!Array.isArray(rows) || !rows.every((row) => typeof row === "string")) return undefined;
  // SAFETY: the element check above proves every member is a string.
  return rows as string[];
}

/**
 * The component a design draws through: the host's rows in, the design's rows out, the live
 * selection read on every pass.
 *
 * With no design selected it answers the host's own rows, byte for byte (S4). A design that throws
 * or answers something that is not rows loses its own output only — the host's rows are what the
 * user sees, and the failure is reported in `/bridge-status` (S5's failure isolation).
 */
function designComponent(args: {
  customType: string;
  host: unknown;
  theme: unknown;
  render: MessageDesignRender;
}): MessageComponentLike {
  const { customType, host, theme, render } = args;
  return {
    render(width: number): string[] {
      const selection = selectionFor(customType);
      const fromHost = hostRows(host, width, customType);
      // `default`, a disposed design, or a design that never claimed this type: the host's rows.
      if (selection.kind !== "design") return fromHost ?? [];
      const rows = fromHost ?? [];
      // S1/S22: resolved ON ACCESS and at most ONCE per pass, so a design that never reads it pays
      // nothing and one that reads it twice cannot draw a card that is half of each style.
      let cardStyle: CardStyleSelection | undefined;
      const ctx: MessageDesignContext = {
        width,
        customType,
        theme,
        render,
        get cardStyle(): CardStyleSelection {
          cardStyle ??= resolveCardStyleSelection();
          return cardStyle;
        },
      };
      const applied = applyMessageDesign(selection.design, rows, ctx);
      return applied ?? rows;
    },
    invalidate(): void {
      if (!isRecord(host)) return;
      const invalidate = host.invalidate;
      if (typeof invalidate === "function") (invalidate as () => void).call(host);
    },
  };
}

/**
 * The renderer the bridge installs for ONE custom type, given the host's own renderer for it (or
 * `undefined` when the host has none).
 *
 * It is the whole policy in one place:
 *
 * - the host's renderer runs first, with Pi's own arguments, and a throw from it stays the host's to
 *   report (Pi's `rebuild()` catches it and draws its default box, byte-identical to before);
 * - with no design selected, its answer is returned as-is — the same component, or `undefined` so Pi
 *   draws its default box (S4);
 * - with a design selected, a component is returned whose `render(width)` re-reads the selection,
 *   renders the host at THAT width and hands the rows to the design (S3), or hands it no rows at all
 *   when the type has no host renderer, so the design owns the box (S2).
 */
export function messageDesignRenderer(
  customType: string,
  host: HostMessageRenderer | undefined,
): HostMessageRenderer {
  return function (message: unknown, options: unknown, theme?: unknown): unknown {
    const selection = selectionFor(customType);
    // The host's own renderer first, always, and exactly once per build: it owns the frame, its
    // arguments and its failures.
    const hostComponent = host === undefined ? undefined : host(message, options, theme);
    // Nothing to draw through: the host's own answer, including `undefined` (S4).
    if (selection.kind !== "design") return hostComponent;
    return designComponent({
      customType,
      host: hostComponent,
      theme,
      render: snapshotRender(message, options),
    });
  };
}
