/**
 * The per-tool DESIGN bus (S4–S7, T7, T8, T11).
 *
 * ONE `pi.registerToolRenderer` resolver is installed by the bridge, and it fans out to the designs
 * plugins registered for a tool name. The resolver runs ONCE per card, at construction, so its
 * wrapper must be the thing that decides: for every tool with at least one registered design it
 * wraps the host's own `renderCall`/`renderResult` components, and on EVERY render pass the wrapper
 * reads the live selection. With no design selected (or a design that disappeared) it renders the
 * host's component and returns its lines byte for byte; with a design selected it hands those lines
 * to the design's `apply`. That is what lets a design chosen AFTER a card was drawn repaint it
 * (S2).
 *
 * Everything asserted here is observable through the published surface: the resolver function, the
 * renderers it returns, the components those renderers build, and the failure/conflict records
 * `/bridge-status` prints. No internal field is read.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { armBridge } from "../src/arm.ts";
import { bridgeApi } from "../src/api.ts";
import { disableCaptureBackend, resetCaptureStateForTests } from "../src/capture.ts";
import gentleShellBridge, { type BridgeExtensionApi } from "../src/extension.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import { resetPluginLinesForTests } from "../src/plugin-lines.ts";
import { resetRepaintForTests } from "../src/repaint.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import {
  TOOL_DESIGN_NATIVE,
  TOOL_DESIGN_STORE_ID,
  designsOfTool,
  getToolDesignConflicts,
  getToolDesignFailures,
  getToolDesignLineSelection,
  getToolDesignSelection,
  registerToolDesign,
  resetToolDesignsForTests,
  resolveToolDesignSelection,
  setToolDesignLineSelection,
  setToolDesignSelection,
  snapshotToolDesigns,
  toolDesignClaims,
  toolDesignLines,
  toolNamesWithDesigns,
} from "../src/tool-designs.ts";
import type {
  ToolDesignCall,
  ToolDesignContext,
  ToolDesignRegistration,
  ToolDesignScope,
} from "../src/types.ts";
import {
  installToolDesignResolver,
  resetToolDesignWiringForTests,
  toolDesignResolver,
} from "../src/tool-design-wiring.ts";
import { createFakeHost } from "./fake-host.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-tool-designs-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
});

test.after(() => {
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  rmSync(configHome, { recursive: true, force: true });
});

const resetAll = (): void => {
  rmSync(join(configHome, "gentle-shell-bridge"), { recursive: true, force: true });
  resetToolDesignsForTests();
  resetToolDesignWiringForTests();
  resetRepaintForTests();
  resetStoreStateForTests();
  resetNoticesForTests();
  resetPluginLinesForTests();
  resetRowBuildStateForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  disableCaptureBackend();
};

test.beforeEach(resetAll);
test.afterEach(disableCaptureBackend);

// ---------------------------------------------------------------------------------------------
// A host-like card: the rows the host itself would draw, ANSI and padding included
// ---------------------------------------------------------------------------------------------

const THEME = { name: "fake-theme", fg: (role: string, text: string) => `${role}:${text}` };

/** The four rows the host draws for a bash call: frame top + hint, `$` heading, body, frame bottom. */
const BASH_CARD = [
  "╭─ ✿ bash card ───────────── ctrl+o ╮",
  "│ \u001b[36m$ ls -la\u001b[0m                ",
  "│ total 4                           ",
  "╰───────────────────────────────────╯",
];

/** `BASH_CARD` with only the heading mark rewritten, i.e. what `bashHeadingDesign` draws. */
const [BASH_HEADING_BEFORE, BASH_HEADING_AFTER] = BASH_CARD[1].split("$ ");
const DESIGNED_BASH_CARD = [
  BASH_CARD[0],
  `${BASH_HEADING_BEFORE}bash ${BASH_HEADING_AFTER}`,
  BASH_CARD[2],
  BASH_CARD[3],
];

/** The second tool's card, so "applies to that tool only" is observable. */
const WRITE_CARD = ["╭─ ✿ write ─╮", "│ ✎ src/index.ts", "╰───────────╯"];

interface FakeComponent {
  render(width: number): string[];
  invalidate(): void;
  renders: () => number;
  lastWidth: () => number | undefined;
}

function fakeComponent(lines: readonly string[]): FakeComponent {
  let renders = 0;
  let lastWidth: number | undefined;
  return {
    render(width: number): string[] {
      renders += 1;
      lastWidth = width;
      return [...lines];
    },
    invalidate(): void {},
    renders: () => renders,
    lastWidth: () => lastWidth,
  };
}

const BASH_HEADING = "bash heading";

/** The design the user asked for: head the card `bash` instead of the host's `$ ` prompt. */
const bashHeadingDesign: ToolDesignRegistration = {
  tool: "bash",
  id: "loon.bash-heading",
  label: BASH_HEADING,
  description: "heads the card with bash instead of the host's $ prompt",
  preview: () => ({ title: "Cards · bash heading", sample: "bash ls -la" }),
  apply(lines: readonly string[], ctx: ToolDesignContext): string[] {
    assert.equal(ctx.tool, "bash");
    return lines.map((line) => (line.includes("$ ") ? line.replace("$ ", "bash ") : line));
  },
};

const writeBadgeDesign: ToolDesignRegistration = {
  tool: "write",
  id: "loon.write-badge",
  label: "write badge",
  apply: (lines: readonly string[]): string[] =>
    lines.map((line) => (line.includes("✎") ? line.replace("✎", "WRITE") : line)),
};

/** A renderer chain shaped like the host's: two components, one per renderer. */
interface FakeRenderers {
  renderShell?: unknown;
  renderCall?: unknown;
  renderResult?: unknown;
  [member: string]: unknown;
}

function fakeRenderers(cards: { call: readonly string[]; result: readonly string[] }): {
  renderers: FakeRenderers;
  call: FakeComponent;
  result: FakeComponent;
} {
  const call = fakeComponent(cards.call);
  const result = fakeComponent(cards.result);
  return {
    renderers: {
      renderShell: "default",
      renderCall: (_args: unknown, _theme: unknown, _ctx: unknown) => call,
      renderResult: (_result: unknown, _options: unknown, _theme: unknown, _ctx: unknown) => result,
    },
    call,
    result,
  };
}

const bashRenderers = () =>
  fakeRenderers({
    call: BASH_CARD,
    result: ["╭─ ✿ bash ─╮", "│ done", "╰──────────╯"],
  });

const writeRenderers = () =>
  fakeRenderers({ call: WRITE_CARD, result: ["╭─ ✿ write ─╮", "│ ok", "╰───────────╯"] });

/** The arguments the host passes that renderer, with the theme at its documented position. */
const rendererArgs = (member: "renderCall" | "renderResult"): unknown[] =>
  member === "renderCall"
    ? [{ command: "ls -la" }, THEME, { args: {} }]
    : [{ content: [] }, { expanded: false }, THEME, { args: {} }];

/**
 * Build the component Pi KEEPS. Pi invokes the resolved renderer once, when it constructs the card
 * (`getRegisteredToolDefinition(toolName)` → `new ToolExecutionComponent(...)`), and re-renders that
 * same object on every later frame. So re-rendering THIS object is what "repaint a card already
 * drawn" means, and a test that builds a new component cannot observe the defect.
 */
const mountCard = (
  renderers: FakeRenderers,
  member: "renderCall" | "renderResult" = "renderCall",
): FakeComponent => {
  const renderer = renderers[member];
  assert.equal(typeof renderer, "function");
  return (renderer as (...values: unknown[]) => FakeComponent)(...rendererArgs(member));
};

/** Render one renderer's component the way the host does: `component.render(width)`. */
const renderThrough = (
  renderers: FakeRenderers,
  member: "renderCall" | "renderResult",
  width: number,
): { lines: string[]; theme: unknown } => ({
  lines: mountCard(renderers, member).render(width),
  theme: THEME,
});

// ---------------------------------------------------------------------------------------------
// T7 — one registry per tool name, conflicts reported
// ---------------------------------------------------------------------------------------------

test("T7: designs are kept per tool name, in registration order", () => {
  registerToolDesign(bashHeadingDesign);
  registerToolDesign(writeBadgeDesign);

  assert.deepEqual(
    snapshotToolDesigns("bash").map((design) => design.id),
    ["loon.bash-heading"],
  );
  assert.deepEqual(
    snapshotToolDesigns("write").map((design) => design.id),
    ["loon.write-badge"],
  );
  assert.deepEqual(toolNamesWithDesigns(), ["bash", "write"], "one registry per tool name");
  assert.deepEqual(snapshotToolDesigns("todo"), [], "a tool with no design has no registry entry");
  assert.deepEqual(getToolDesignConflicts(), [], "nothing was replaced or refused");
});

test("T7: a second registration for the same tool and id replaces in place and is REPORTED", () => {
  const first = registerToolDesign(bashHeadingDesign);
  const replacement: ToolDesignRegistration = { ...bashHeadingDesign, label: "bash command" };
  registerToolDesign(replacement);

  assert.deepEqual(
    snapshotToolDesigns("bash").map((design) => design.id),
    ["loon.bash-heading"],
    "there is still exactly one value for that id",
  );
  assert.equal(snapshotToolDesigns("bash")[0], replacement, "the later registration is the live one");
  const conflicts = getToolDesignConflicts();
  assert.equal(conflicts.length, 1, "the replacement is reported instead of silently happening");
  assert.equal(conflicts[0].tool, "bash");
  assert.equal(conflicts[0].id, "loon.bash-heading");
  assert.equal(conflicts[0].kind, "replaced");

  // The replaced registration's disposer cannot remove the replacement.
  first();
  assert.equal(snapshotToolDesigns("bash").length, 1);
});

test("T7: two designs of one tool cannot share a visible label, and the clash is reported", () => {
  registerToolDesign(bashHeadingDesign);

  assert.throws(
    () => registerToolDesign({ ...bashHeadingDesign, id: "loon.other", apply: (lines) => [...lines] }),
    /already used by "loon\.bash-heading"/u,
  );
  assert.deepEqual(
    snapshotToolDesigns("bash").map((design) => design.id),
    ["loon.bash-heading"],
    "a refused registration never half-registers",
  );
  assert.equal(getToolDesignConflicts().length, 1);
  assert.equal(getToolDesignConflicts()[0].kind, "label");

  // `native` is the row's own "the tool's own card" value, so a design may not read it too.
  assert.throws(
    () => registerToolDesign({ ...bashHeadingDesign, id: "loon.native", label: TOOL_DESIGN_NATIVE }),
    /native/u,
  );
  // The same id in two different tools is NOT a conflict: identity is (tool, id).
  registerToolDesign({ ...writeBadgeDesign, id: bashHeadingDesign.id });
  assert.deepEqual(toolNamesWithDesigns(), ["bash", "write"]);
});

test("T7: a malformed registration throws before anything is stored", () => {
  for (const invalid of [
    { ...bashHeadingDesign, tool: "" },
    { ...bashHeadingDesign, id: "" },
    { ...bashHeadingDesign, label: "" },
    { ...bashHeadingDesign, apply: undefined },
  ]) {
    assert.throws(() => registerToolDesign(invalid as unknown as ToolDesignRegistration));
  }
  assert.deepEqual(toolNamesWithDesigns(), []);
});

test("T7: the published API carries the registration a plugin that never imports the package needs", () => {
  const api = bridgeApi();
  assert.equal(typeof api?.registerToolDesign, "function", "the slot publishes the bus");
  api?.registerToolDesign?.(bashHeadingDesign);
  assert.deepEqual(
    snapshotToolDesigns("bash").map((design) => design.id),
    ["loon.bash-heading"],
    "it is the working function, not a stale copy",
  );
});

test("T7: /bridge-status reports the tools, the selection and every conflict", () => {
  registerToolDesign(bashHeadingDesign);
  setToolDesignSelection("bash", "loon.bash-heading");
  // A second registration for the same (tool, id) is the reportable conflict.
  registerToolDesign({ ...bashHeadingDesign, label: "bash command" });

  const snapshot = collectStatus();
  assert.ok(snapshot.toolDesigns !== undefined, "a session with designs reports the block");
  assert.deepEqual(
    snapshot.toolDesigns.tools.map((entry) => entry.tool),
    ["bash"],
  );
  assert.equal(snapshot.toolDesigns.tools[0].selection, "loon.bash-heading");
  assert.equal(snapshot.toolDesigns.conflicts[0].kind, "replaced");

  const report = formatStatus(snapshot).join("\n");
  assert.match(report, /tool designs: 1 tools with designs/u);
  assert.match(report, /loon\.bash-heading "bash command"/u);
  assert.match(report, /tool design conflicts: 1/u);
  assert.match(report, /tool design resolver: /u);
});

test("T7/S2: /bridge-status says which design resolves AND whether that tool's cards are wrapped", () => {
  registerToolDesign(bashHeadingDesign);

  let snapshot = collectStatus();
  assert.ok(snapshot.toolDesigns !== undefined);
  assert.equal(snapshot.toolDesigns.tools[0].selection, TOOL_DESIGN_NATIVE);
  assert.equal(
    snapshot.toolDesigns.tools[0].wrapper,
    "not mounted",
    "no card of this tool has been built through the wrapper yet",
  );
  assert.match(formatStatus(snapshot).join("\n"), /- bash: native, wrapper not mounted/u);

  // One card is constructed while a design is selected: now the wrapper IS mounted on a card.
  setToolDesignSelection("bash", "loon.bash-heading");
  const { renderers } = bashRenderers();
  const resolved = toolDesignResolver("bash", () => renderers);
  assert.ok(resolved !== undefined);
  mountCard(resolved).render(80);

  snapshot = collectStatus();
  assert.ok(snapshot.toolDesigns !== undefined);
  assert.equal(snapshot.toolDesigns.tools[0].selection, "loon.bash-heading");
  assert.equal(snapshot.toolDesigns.tools[0].wrapper, "mounted");
  assert.equal(snapshot.toolDesigns.tools[0].cards, 1, "one component was built through the wrapper");
  assert.match(
    formatStatus(snapshot).join("\n"),
    /- bash: loon\.bash-heading, wrapper mounted on 1 card/u,
  );
});

test("T7: the selection is persisted per TOOL, in the bridge's own store", () => {
  registerToolDesign(bashHeadingDesign);
  registerToolDesign(writeBadgeDesign);

  assert.equal(getToolDesignSelection("bash"), TOOL_DESIGN_NATIVE, "the tool's own card by default");
  setToolDesignSelection("bash", "loon.bash-heading");
  setToolDesignSelection("write", "loon.write-badge");

  assert.equal(getToolDesignSelection("bash"), "loon.bash-heading");
  assert.equal(getToolDesignSelection("write"), "loon.write-badge");
  assert.equal(getToolDesignSelection("edit"), TOOL_DESIGN_NATIVE, "each tool has its own value");

  const stored = JSON.parse(
    readFileSync(join(configHome, "gentle-shell-bridge", `${TOOL_DESIGN_STORE_ID}.json`), "utf8"),
  );
  assert.deepEqual(stored.values.selections, {
    bash: "loon.bash-heading",
    write: "loon.write-badge",
  });

  assert.equal(resolveToolDesignSelection("bash").kind, "design");
  setToolDesignSelection("bash", "loon.disposed");
  assert.deepEqual(resolveToolDesignSelection("bash"), { kind: "missing", id: "loon.disposed" });
});

// ---------------------------------------------------------------------------------------------
// T8 — the ONE resolver: host renderers, untouched unless a design is selected
// ---------------------------------------------------------------------------------------------

test("T8: with no design registered the host's renderers come back as the SAME object", () => {
  const { renderers } = bashRenderers();

  const resolved = toolDesignResolver("bash", () => renderers);

  assert.equal(resolved, renderers, "identity: returning next() composes, it does not replace");
});

test("T8/S2: a registered design that is NOT selected draws the host's bytes through a live wrapper", () => {
  registerToolDesign(bashHeadingDesign);
  const { renderers } = bashRenderers();

  const resolved = toolDesignResolver("bash", () => renderers);
  assert.ok(resolved !== undefined);

  // NOT the same object, and that is the point. Returning `next()` itself while nothing is selected
  // was the wrong contract: Pi resolves ONCE per card and keeps that component, so a card built
  // with the host's own object has no wrapper to ask on a later frame — a design selected afterwards
  // could never repaint it, which is exactly the defect the user reported ("cambiar tanto las
  // antiguas como posteriores"). The identity that must hold is the identity of the OUTPUT: same
  // rows, same bytes, drawn by the host's own component.
  assert.notEqual(resolved, renderers, "a tool with a design is always wrapped, selected or not");
  assert.equal(resolved.renderShell, "default", "every untouched member is the host's own value");
  assert.equal(typeof resolved.renderResult, "function", "both renderers are carried over");

  assert.deepEqual(
    renderThrough(resolved, "renderCall", 80).lines,
    BASH_CARD,
    "no selection: the host's rows, byte for byte, ANSI and trailing padding included",
  );
});

test("S2: a design selected AFTER the card was drawn repaints THAT card, and deselecting restores it", () => {
  // The design is registered before the card exists (the resolver must already know that this tool
  // has a design), and NOTHING is selected: the card is built in the state the user starts in.
  registerToolDesign(bashHeadingDesign);
  const { renderers } = bashRenderers();
  const resolved = toolDesignResolver("bash", () => renderers);
  assert.ok(resolved !== undefined);

  // Pi's one resolution per card: this object is what every later frame re-renders.
  const card = mountCard(resolved);

  assert.deepEqual(card.render(80), BASH_CARD, "built with no design selected: the host's own bytes");

  // The user picks the design on the LIVE bus, after the card was already drawn.
  setToolDesignSelection("bash", "loon.bash-heading");
  assert.deepEqual(
    card.render(80),
    DESIGNED_BASH_CARD,
    "the same, already-constructed component now shows the selected design",
  );

  // And back: deselecting repaints the same component with the host's bytes, not a fresh card's.
  setToolDesignSelection("bash", TOOL_DESIGN_NATIVE);
  assert.deepEqual(card.render(80), BASH_CARD, "deselecting brings the host's own rows back");
});

test("S2: a design selected after the card was drawn applies to the RESULT renderer too", () => {
  registerToolDesign({
    tool: "bash",
    id: "loon.bash-result",
    label: "bash result",
    apply: (lines: readonly string[]) => lines.map((line) => line.replace("done", "bash done")),
  });
  const { renderers } = bashRenderers();
  const resolved = toolDesignResolver("bash", () => renderers);
  assert.ok(resolved !== undefined);
  const card = mountCard(resolved, "renderResult");

  assert.deepEqual(card.render(60), ["╭─ ✿ bash ─╮", "│ done", "╰──────────╯"]);
  setToolDesignSelection("bash", "loon.bash-result");
  assert.deepEqual(card.render(60), ["╭─ ✿ bash ─╮", "│ bash done", "╰──────────╯"]);
});

test("T8: an unknown tool name is untouched, and no next() means no renderers", () => {
  registerToolDesign(bashHeadingDesign);
  setToolDesignSelection("bash", "loon.bash-heading");
  const { renderers } = writeRenderers();

  assert.equal(toolDesignResolver("todo", () => renderers), renderers, "an unknown tool is untouched");
  assert.equal(toolDesignResolver("bash", () => undefined), undefined, "no host renderers, nothing to wrap");
});

test("T8: a selected design wraps the host's components and changes only the rows it rewrites", () => {
  registerToolDesign(bashHeadingDesign);
  setToolDesignSelection("bash", "loon.bash-heading");
  const { renderers } = bashRenderers();

  const resolved = toolDesignResolver("bash", () => renderers);
  assert.ok(resolved !== undefined);
  assert.notEqual(resolved, renderers, "a selected design returns a wrapper, never the host object");
  assert.equal(resolved.renderShell, "default", "every other renderer member is carried over");

  const call = renderThrough(resolved, "renderCall", 80);
  // Every byte the design did not deliberately change is the host's own: the same rows, the same
  // ANSI sequences, the same trailing padding — only `$ ` became `bash ` on the heading row.
  const [beforeHeading, afterHeading] = BASH_CARD[1].split("$ ");
  assert.deepEqual(call.lines, [
    BASH_CARD[0],
    `${beforeHeading}bash ${afterHeading}`,
    BASH_CARD[2],
    BASH_CARD[3],
  ]);
  for (const [index, line] of call.lines.entries()) {
    if (index === 1) continue;
    assert.equal(line, BASH_CARD[index], `row ${index} must be byte-identical`);
  }
  assert.ok(call.lines[1].includes("\u001b[36m"), "ANSI sequences survive the design");
  assert.ok(call.lines[1].endsWith(afterHeading), "and so does the host's trailing padding");

  const result = renderThrough(resolved, "renderResult", 60);
  assert.equal(result.lines.length, 3, "the result renderer is wrapped the same way");
});

test("T8: a selection nobody owns draws the host's card, and the next pass picks a live design up", () => {
  registerToolDesign(bashHeadingDesign);
  setToolDesignSelection("bash", "loon.disposed");
  const { renderers } = bashRenderers();

  const resolved = toolDesignResolver("bash", () => renderers);
  assert.ok(resolved !== undefined);
  assert.deepEqual(resolveToolDesignSelection("bash"), { kind: "missing", id: "loon.disposed" });

  const card = mountCard(resolved);
  assert.deepEqual(card.render(80), BASH_CARD, "a disposed design degrades to the host's own rows");

  setToolDesignSelection("bash", "loon.bash-heading");
  assert.deepEqual(
    card.render(80),
    DESIGNED_BASH_CARD,
    "the SAME card follows the live selection on its next pass",
  );
});

test("T8: a design for another tool applies to that tool only", () => {
  registerToolDesign(bashHeadingDesign);
  registerToolDesign(writeBadgeDesign);
  setToolDesignSelection("write", "loon.write-badge");

  const write = writeRenderers();
  const bash = bashRenderers();
  const resolvedWrite = toolDesignResolver("write", () => write.renderers);
  const resolvedBash = toolDesignResolver("bash", () => bash.renderers);

  assert.ok(resolvedWrite !== undefined && resolvedWrite !== write.renderers);
  assert.ok(resolvedBash !== undefined);
  assert.notEqual(resolvedBash, bash.renderers, "bash has designs, so its card is wrapped too");
  assert.deepEqual(
    renderThrough(resolvedBash, "renderCall", 80).lines,
    BASH_CARD,
    "but with no selection it draws the host's own bytes, and never write's design",
  );
  assert.deepEqual(renderThrough(resolvedWrite, "renderCall", 80).lines, [
    "╭─ ✿ write ─╮",
    "│ WRITE src/index.ts",
    "╰───────────╯",
  ]);
});

test("T8/T20: the design receives the width the host asked for, its tool, the theme and the part", () => {
  const seen: ToolDesignContext[] = [];
  registerToolDesign({
    ...bashHeadingDesign,
    apply: (lines: readonly string[], ctx: ToolDesignContext): string[] => {
      seen.push(ctx);
      return [...lines];
    },
  });
  setToolDesignSelection("bash", "loon.bash-heading");
  const { renderers } = bashRenderers();
  const resolved = toolDesignResolver("bash", () => renderers);
  assert.ok(resolved !== undefined);

  renderThrough(resolved, "renderCall", 72);
  renderThrough(resolved, "renderResult", 41);

  // The two renderers are wrapped SEPARATELY and each says which half of the card it draws (S12): the
  // host draws both with the same chrome, so the rows alone cannot tell a heading from output.
  const { render: _callRender, ...callContext } = seen[0];
  const { render: _resultRender, ...resultContext } = seen[1];
  assert.deepEqual(callContext, { width: 72, tool: "bash", theme: THEME, part: "call" });
  assert.deepEqual(
    resultContext,
    { width: 41, tool: "bash", theme: THEME, part: "result" },
    "the theme is the host's own, and the part is the renderer's own",
  );
});

test("S12: the design reads the host's render context by value, live, for both halves of a card", () => {
  const seen: ToolDesignContext[] = [];
  registerToolDesign({
    ...bashHeadingDesign,
    apply: (lines: readonly string[], ctx: ToolDesignContext): string[] => {
      seen.push(ctx);
      return [...lines];
    },
  });
  setToolDesignSelection("bash", "loon.bash-heading");
  const { renderers } = bashRenderers();
  const resolved = toolDesignResolver("bash", () => renderers);
  assert.ok(resolved !== undefined);

  // Pi's context is a live object: `durationMs` and `isPartial` change after the call was built.
  const hostContext: Record<string, unknown> = {
    toolCallId: "call-1",
    args: { command: "ls -la" },
    isPartial: true,
    isError: false,
    durationMs: undefined,
    expanded: false,
    invalidate: () => undefined,
    state: { secret: true },
  };
  const call = (resolved.renderCall as (...values: unknown[]) => FakeComponent)({}, THEME, hostContext);
  const result = (resolved.renderResult as (...values: unknown[]) => FakeComponent)({}, {}, THEME, hostContext);
  call.render(80);
  hostContext.isPartial = false;
  hostContext.durationMs = 142;
  result.render(80);

  assert.deepEqual(seen[0].render, {
    toolCallId: "call-1",
    args: { command: "ls -la" },
    isPartial: true,
    isError: false,
    expanded: false,
  });
  assert.deepEqual(seen[1].render, {
    toolCallId: "call-1",
    args: { command: "ls -la" },
    isPartial: false,
    isError: false,
    durationMs: 142,
    expanded: false,
  });
  assert.ok(!("state" in (seen[1].render ?? {})), "nothing beyond the documented fields is forwarded");
  assert.ok(!("invalidate" in (seen[1].render ?? {})), "no host function reaches a design");
});

test("S12 on a grouped LINE: every tool the line paints gets its own ctx.tool and ctx.render", () => {
  const seen: ToolDesignContext[] = [];
  registerToolDesign(
    groupedDesign({
      tools: ["bash", "write"],
      apply: (lines: readonly string[], ctx: ToolDesignContext): string[] => {
        seen.push(ctx);
        return [...lines];
      },
    }),
  );
  setToolDesignLineSelection("line", "tools", "loon.tools-activity");

  // The same shape Pi hands a grouped design: the call's identity, its arguments, its state.
  const hostContext = {
    toolCallId: "call-1",
    args: { command: "ls -la" },
    isPartial: false,
    isError: true,
    durationMs: 12,
    expanded: false,
    state: { secret: true },
  };
  const render = (tool: string, card: readonly string[]): void => {
    const resolved = toolDesignResolver(tool, () => fakeRenderers({ call: card, result: card }).renderers);
    assert.ok(resolved !== undefined, `${tool}: the line wraps its card`);
    const component = (resolved.renderCall as (...values: unknown[]) => FakeComponent)(
      {},
      THEME,
      hostContext,
    );
    assert.deepEqual(component.render(80), card, `${tool}: the design draws the host's rows`);
  };

  render("bash", BASH_CARD);
  render("write", WRITE_CARD);

  const expected = {
    toolCallId: "call-1",
    args: { command: "ls -la" },
    isPartial: false,
    isError: true,
    durationMs: 12,
    expanded: false,
  };
  assert.equal(seen.length, 2, "apply runs once per pass, one pass per tool");
  assert.deepEqual(seen.map((ctx) => ctx.tool), ["bash", "write"], "ctx.tool names the tool the line painted");
  assert.deepEqual(seen[0].render, expected, "the line path forwards `render` exactly like the per-tool path");
  assert.deepEqual(seen[1].render, expected);
  assert.ok(!("state" in (seen[1].render ?? {})), "nothing beyond the documented fields crosses");
});

test("S12: no render context from the host, no `render` on the design's context", () => {
  const seen: ToolDesignContext[] = [];
  registerToolDesign({
    ...bashHeadingDesign,
    apply: (lines: readonly string[], ctx: ToolDesignContext): string[] => {
      seen.push(ctx);
      return [...lines];
    },
  });
  setToolDesignSelection("bash", "loon.bash-heading");
  const { renderers } = bashRenderers();
  const resolved = toolDesignResolver("bash", () => renderers);
  assert.ok(resolved !== undefined);
  (resolved.renderCall as (...values: unknown[]) => FakeComponent)({}, THEME).render(80);
  assert.ok(!("render" in seen[0]));
  const bad = (resolved.renderCall as (...values: unknown[]) => FakeComponent)({}, THEME, {
    durationMs: Number.NaN,
    isPartial: "yes",
    toolCallId: 7,
  });
  bad.render(80);
  assert.deepEqual(seen[1].render, {}, "a field with the wrong type is dropped, never coerced");
});

test("S12: a host context whose accessors throw costs the design its `render`, never the frame", () => {
  const seen: ToolDesignContext[] = [];
  registerToolDesign({
    ...bashHeadingDesign,
    apply: (lines: readonly string[], ctx: ToolDesignContext): string[] => {
      seen.push(ctx);
      return [...lines];
    },
  });
  setToolDesignSelection("bash", "loon.bash-heading");
  const { renderers } = bashRenderers();
  const resolved = toolDesignResolver("bash", () => renderers);
  assert.ok(resolved !== undefined);
  const hostile = new Proxy(
    {},
    {
      has() {
        throw new Error("no");
      },
      get() {
        throw new Error("no");
      },
    },
  );
  const call = (resolved.renderCall as (...values: unknown[]) => FakeComponent)({}, THEME, hostile);
  const rows = call.render(80);
  assert.ok(Array.isArray(rows), "the frame still draws");
  assert.equal(seen.length, 1, "the design still ran");
  assert.ok(!("render" in seen[0]), "without a readable context the design gets no `render`");
});

test("the line SHOWS `default` for the host's card, so no design may take `default` or `native` as its label", () => {
  for (const label of ["default", "native"]) {
    assert.throws(
      () => registerToolDesign({ ...bashHeadingDesign, id: `loon.${label}`, label }),
      /reserved value/u,
      `${label} is refused`,
    );
  }
  assert.deepEqual(snapshotToolDesigns("bash"), [], "a refused design never half-registers");
  // The stored identity is unchanged: a saved `native` still means the host's own card.
  assert.equal(getToolDesignSelection("bash"), TOOL_DESIGN_NATIVE);
});

test("an array registers several designs in order and one disposer removes exactly them", () => {
  const framed: ToolDesignRegistration = { ...bashHeadingDesign, id: "loon.bash-framed", label: "bash framed" };
  const dispose = registerToolDesign([bashHeadingDesign, framed, writeBadgeDesign]);
  assert.deepEqual(
    snapshotToolDesigns("bash").map((design) => design.id),
    ["loon.bash-heading", "loon.bash-framed"],
    "two designs of one tool join that tool's one line, in order",
  );
  assert.deepEqual(toolNamesWithDesigns(), ["bash", "write"]);
  dispose();
  assert.deepEqual(toolNamesWithDesigns(), []);
  dispose();
});

test("an array with one refused design registers none of them", () => {
  const bad = { ...writeBadgeDesign, label: "default" };
  assert.throws(() => registerToolDesign([bashHeadingDesign, bad]), /reserved value/u);
  assert.deepEqual(toolNamesWithDesigns(), [], "the design before the refused one is rolled back");
});

test("T20/S12: a design that ignores `part` draws exactly the rows it drew before the field existed", () => {
  // Additive means additive: a design written against the older context keeps its own behaviour, and
  // the field it never reads changes nothing about what reaches the screen.
  const partBlind: ToolDesignRegistration = {
    tool: "bash",
    id: "loon.part-blind",
    label: "part blind",
    apply: (lines: readonly string[]): string[] => lines.map((line) => line.replace("bash", "BASH")),
  };
  registerToolDesign(partBlind);
  setToolDesignSelection("bash", "loon.part-blind");
  const { renderers } = bashRenderers();
  const resolved = toolDesignResolver("bash", () => renderers);
  assert.ok(resolved !== undefined);

  // The same rewrite, byte for byte, in both renderers: the call's own rows and the result's own rows,
  // edited by the one rule the design states and nothing else.
  assert.deepEqual(renderThrough(resolved, "renderCall", 80).lines, [
    "╭─ ✿ BASH card ───────────── ctrl+o ╮",
    "│ \u001b[36m$ ls -la\u001b[0m                ",
    "│ total 4                           ",
    "╰───────────────────────────────────╯",
  ]);
  assert.deepEqual(renderThrough(resolved, "renderResult", 60).lines, [
    "╭─ ✿ BASH ─╮",
    "│ done",
    "╰──────────╯",
  ]);
});

test("T8: an apply that throws leaves the host's card intact and is reported ONCE", () => {
  const failing: ToolDesignRegistration = {
    ...bashHeadingDesign,
    id: "loon.thrower",
    apply: () => {
      throw new Error("design exploded");
    },
  };
  registerToolDesign(failing);
  setToolDesignSelection("bash", "loon.thrower");
  const { renderers } = bashRenderers();
  const resolved = toolDesignResolver("bash", () => renderers);
  assert.ok(resolved !== undefined);

  assert.deepEqual(renderThrough(resolved, "renderCall", 80).lines, BASH_CARD);
  assert.deepEqual(renderThrough(resolved, "renderCall", 80).lines, BASH_CARD, "every frame stays whole");

  const failures = getToolDesignFailures();
  assert.equal(failures.length, 1, "one fact, not one per frame");
  assert.equal(failures[0].tool, "bash");
  assert.equal(failures[0].designId, "loon.thrower");
  assert.match(failures[0].message, /design exploded/u);
});

test("T8: an apply that returns nonsense is a failure, never a broken card", () => {
  registerToolDesign({
    ...bashHeadingDesign,
    id: "loon.nonsense",
    apply: (() => [42]) as unknown as ToolDesignRegistration["apply"],
  });
  setToolDesignSelection("bash", "loon.nonsense");
  const { renderers } = bashRenderers();
  const resolved = toolDesignResolver("bash", () => renderers);
  assert.ok(resolved !== undefined);

  assert.deepEqual(renderThrough(resolved, "renderCall", 80).lines, BASH_CARD);
  assert.equal(getToolDesignFailures().length, 1);
});

// ---------------------------------------------------------------------------------------------
// T8 — one registration point, at the same moment the bridge arms its other surfaces
// ---------------------------------------------------------------------------------------------

interface FakePi {
  pi: BridgeExtensionApi;
  resolvers: unknown[];
  fireSessionStart: () => void;
}

function fakePi(): FakePi {
  const resolvers: unknown[] = [];
  let sessionStart: (() => unknown) | undefined;
  const pi: BridgeExtensionApi = {
    // `gentle-pi` is present, so `session_start` installs the resolver (S9/T12).
    getCommands: () => [{ name: "gentle:customize" }],
    on(event, handler) {
      if (event === "session_start") sessionStart = () => handler({}, { hasUI: true, ui: createFakeHost().ui });
    },
    registerCommand() {},
    registerToolRenderer(resolver) {
      resolvers.push(resolver);
    },
  };
  return {
    pi,
    resolvers,
    fireSessionStart: () => {
      sessionStart?.();
    },
  };
}

test("T8: the bridge registers exactly one resolver, and re-arming registers none", () => {
  const fake = fakePi();

  gentleShellBridge(fake.pi);
  fake.fireSessionStart();

  assert.equal(fake.resolvers.length, 1, "ONE resolution point for the whole package");
  assert.equal(fake.resolvers[0], toolDesignResolver);

  fake.fireSessionStart();
  installToolDesignResolver(fake.pi);
  assert.equal(fake.resolvers.length, 1, "a rebind or a second arm adds no second resolver");
});

test("T8: a second loaded copy shares the slot and does not register a second resolver", async () => {
  const fake = fakePi();
  gentleShellBridge(fake.pi);
  fake.fireSessionStart();
  assert.equal(fake.resolvers.length, 1);

  // Pi loads every extension with `moduleCache: false`, so this module genuinely exists twice.
  const copy = (await import(new URL("../src/tool-design-wiring.ts?second-copy", import.meta.url).href)) as
    typeof import("../src/tool-design-wiring.ts");
  const result = copy.installToolDesignResolver(fake.pi);

  assert.equal(result.outcome, "already-registered");
  assert.equal(fake.resolvers.length, 1, "the process-global slot is the idempotency key");
});

test("T8: a host without registerToolRenderer is a reported outcome, never a throw", () => {
  const result = installToolDesignResolver({ on() {}, registerCommand() {} });
  assert.equal(result.installed, false);
  assert.equal(result.outcome, "no-register-function");
});

test("PRESERVE: arming without a UI registers nothing, exactly as before", () => {
  const resolvers: unknown[] = [];
  let sessionStart: ((event: unknown, ctx: unknown) => unknown) | undefined;
  const pi: BridgeExtensionApi = {
    on(event, handler) {
      if (event === "session_start") sessionStart = handler as (event: unknown, ctx: unknown) => unknown;
    },
    registerCommand() {},
    registerToolRenderer(resolver) {
      resolvers.push(resolver);
    },
  };
  gentleShellBridge(pi);
  sessionStart?.({}, { hasUI: false });

  assert.deepEqual(resolvers, []);
});

test("PRESERVE: armBridge still reports its own outcome with designs registered", () => {
  registerToolDesign(bashHeadingDesign);
  const host = createFakeHost();
  const result = armBridge(host.ui);
  assert.notEqual(result.backend, "none", "the design bus never changes the row interception");
});

// ---------------------------------------------------------------------------------------------
// S1–S8 — ONE line over several tools (the grouped registration)
// ---------------------------------------------------------------------------------------------

/** A grouped registration: one line, several tools, same `apply`. */
const groupedDesign = (overrides: Partial<ToolDesignRegistration> = {}): ToolDesignRegistration => ({
  line: "tools",
  tools: ["bash", "write", "read"],
  id: "loon.tools-activity",
  label: "activity",
  apply: (lines: readonly string[]) => [...lines],
  ...overrides,
});

/**
 * The stored value `/bridge-status` and the tests read: the bridge's own file, never the host's config.
 * ONE document holds both maps — the tool selections flat, the lines under the reserved key — so a
 * frame reads the file once (S9/D6).
 */
const readDesignStore = (): { selections?: Record<string, unknown>; lines: Record<string, unknown> } => {
  const values = JSON.parse(
    readFileSync(join(configHome, "gentle-shell-bridge", `${TOOL_DESIGN_STORE_ID}.json`), "utf8"),
  ).values as Record<string, unknown>;
  const stored = values["selections"];
  const document =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const { $lines, ...selections } = document;
  return {
    ...(Object.keys(selections).length === 0 ? {} : { selections }),
    lines:
      typeof $lines === "object" && $lines !== null && !Array.isArray($lines)
        ? ($lines as Record<string, unknown>)
        : {},
  };
};

test("S2/S3: a grouped registration names ONE line and paints the union of its tools", () => {
  registerToolDesign(groupedDesign({ tools: ["bash", "write"] }));
  registerToolDesign(
    groupedDesign({ id: "loon.tools-complete", label: "complete", tools: ["write", "read"] }),
  );

  assert.deepEqual(
    toolDesignLines().map((line) => ({ scope: line.scope, line: line.line, tools: line.tools })),
    [{ scope: "line", line: "tools", tools: ["bash", "write", "read"] }],
    "two registrations naming the same line join it; its tool set is the union",
  );
  assert.deepEqual(
    toolDesignLines()[0]?.designs.map((design) => design.id),
    ["loon.tools-activity", "loon.tools-complete"],
    "the line's values stay in registration order",
  );
  assert.deepEqual(designsOfTool("read").map((design) => design.id), ["loon.tools-complete"]);
  assert.deepEqual(toolNamesWithDesigns(), ["bash", "write", "read"]);
});

test("S2: mixing `tool` with `line`/`tools`, an empty tool set and duplicates are refused whole", () => {
  for (const invalid of [
    { ...groupedDesign(), tool: "bash" },
    { ...bashHeadingDesign, tools: ["bash"] },
    { line: "tools", tools: [], id: "loon.empty", label: "empty", apply: groupedDesign().apply },
    {
      line: "tools",
      tools: ["bash", "bash"],
      id: "loon.dupe",
      label: "dupe",
      apply: groupedDesign().apply,
    },
    { line: "tools", tools: [""], id: "loon.blank", label: "blank", apply: groupedDesign().apply },
    { line: "", tools: ["bash"], id: "loon.noline", label: "no line", apply: groupedDesign().apply },
    { line: "tools", id: "loon.notools", label: "no tools", apply: groupedDesign().apply },
  ]) {
    assert.throws(() => registerToolDesign(invalid as unknown as ToolDesignRegistration));
  }
  assert.deepEqual(toolDesignLines(), [], "a refused registration never half-registers");
});

test("S3: an array may mix an ungrouped and a grouped registration, and stays all-or-nothing", () => {
  const dispose = registerToolDesign([
    bashHeadingDesign,
    groupedDesign({ tools: ["grep"] }),
    writeBadgeDesign,
  ]);
  assert.deepEqual(toolNamesWithDesigns(), ["bash", "grep", "write"]);
  dispose();
  assert.deepEqual(toolNamesWithDesigns(), []);

  assert.throws(() => registerToolDesign([bashHeadingDesign, groupedDesign({ tools: ["bash"] })]));
  assert.deepEqual(
    toolNamesWithDesigns(),
    [],
    "the ungrouped registration before the refused grouped one is rolled back",
  );
});

test("S5/D1: a tool belongs to at most one line; a second line refuses the WHOLE registration and is reported", () => {
  registerToolDesign(bashHeadingDesign);

  assert.throws(() => registerToolDesign(groupedDesign({ tools: ["write", "bash"] })));
  assert.deepEqual(toolNamesWithDesigns(), ["bash"], "no half-registration: write joined nothing");
  const conflict = getToolDesignConflicts().at(-1);
  assert.equal(conflict?.kind, "line");
  assert.equal(conflict?.tool, "bash");

  registerToolDesign(groupedDesign({ tools: ["grep"], id: "loon.tools-grep" }));
  assert.throws(() => registerToolDesign({ ...writeBadgeDesign, tool: "grep" }));
  assert.deepEqual(toolNamesWithDesigns(), ["bash", "grep"], "and so is a legacy registration on that tool");
  assert.equal(getToolDesignConflicts().at(-1)?.kind, "line");
});

test("D2: the same (line, id) replaces in place and is reported, and its tools are the later one's", () => {
  const first = registerToolDesign(groupedDesign({ tools: ["bash"] }));
  registerToolDesign(groupedDesign({ tools: ["write"], label: "activity two" }));

  assert.deepEqual(toolDesignLines()[0]?.tools, ["write"], "the later registration's tool set is the line's");
  assert.deepEqual(designsOfTool("bash"), [], "a tool the replacement dropped leaves the line");
  assert.deepEqual(snapshotToolDesigns("write").map((design) => design.id), ["loon.tools-activity"]);
  const replaced = getToolDesignConflicts().find((conflict) => conflict.kind === "replaced");
  assert.ok(replaced !== undefined);
  assert.equal(replaced.tool, "tools", "the report names the line the value belongs to");

  first();
  assert.equal(designsOfTool("write").length, 1, "the replaced registration's disposer removes nothing");
});

test("S6/S7/D4: the selection is per LINE, and a covered tool outside the selected value is `not covered`", () => {
  registerToolDesign(groupedDesign({ tools: ["bash", "grep"], id: "loon.tools-activity" }));
  registerToolDesign(groupedDesign({ tools: ["bash"], id: "loon.tools-complete", label: "complete" }));

  assert.equal(getToolDesignLineSelection("line", "tools"), TOOL_DESIGN_NATIVE, "default first");
  setToolDesignLineSelection("line", "tools", "loon.tools-complete");
  assert.equal(getToolDesignLineSelection("line", "tools"), "loon.tools-complete");

  assert.equal(resolveToolDesignSelection("bash").kind, "design");
  assert.deepEqual(
    resolveToolDesignSelection("grep"),
    { kind: "not-covered", id: "loon.tools-complete" },
    "the line covers grep, the value does not: it draws default and says why",
  );
  assert.deepEqual(readDesignStore().lines, { tools: "loon.tools-complete" });
  assert.equal(readDesignStore().selections, undefined, "per-line choices never touch the per-tool map");

  setToolDesignLineSelection("line", "tools", "loon.gone");
  assert.deepEqual(resolveToolDesignSelection("bash"), { kind: "missing", id: "loon.gone" });
});

test("D3: joining a line migrates the joining tool's legacy per-tool value ONCE, at registration", () => {
  // The shape a store written before `line` existed has: a per-tool value and no `lines` key.
  setToolDesignSelection("bash", "loon.tools-activity");

  registerToolDesign(groupedDesign({ tools: ["bash", "grep"] }));

  assert.equal(getToolDesignLineSelection("line", "tools"), "loon.tools-activity");
  assert.deepEqual(
    readDesignStore().selections,
    { bash: "loon.tools-activity" },
    "the legacy map is kept exactly as it was",
  );
  assert.deepEqual(readDesignStore().lines, { tools: "loon.tools-activity" });
  assert.equal(resolveToolDesignSelection("bash").kind, "design");

  // A line that already has a stored value is never migrated again, even when a later tool joins.
  setToolDesignSelection("grep", "loon.tools-complete");
  registerToolDesign(groupedDesign({ id: "loon.tools-complete", label: "complete", tools: ["grep"] }));
  assert.equal(getToolDesignLineSelection("line", "tools"), "loon.tools-activity");
});

test("S5/D2: a failed batch RESTORES the grouped design it replaced on its way", () => {
  const original = groupedDesign({ tools: ["bash", "grep"] });
  registerToolDesign(original);
  setToolDesignLineSelection("line", "tools", "loon.tools-activity");

  assert.throws(() =>
    registerToolDesign([
      // Replaces `(line, tools)` and narrows its tools to bash...
      groupedDesign({ tools: ["bash"], label: "replacement" }),
      // ...then fails on the tool bash now belongs to.
      bashHeadingDesign,
    ]),
  );

  assert.deepEqual(
    toolDesignLines().map((line) => ({ line: line.line, tools: line.tools })),
    [{ line: "tools", tools: ["bash", "grep"] }],
    "the replaced registration is back, with its own tools",
  );
  assert.equal(designsOfTool("grep")[0], original, "grep is painted again");
  assert.equal(resolveToolDesignSelection("bash").kind, "design");
});

test("D3: a store that cannot be migrated leaves the registration live and reported, never a throw", () => {
  const activity = groupedDesign({ tools: ["bash"] });
  registerToolDesign(activity);
  // The migration only runs when a line has no value yet; force the store to refuse the write.
  const blocked = mkdtempSync(join(tmpdir(), "gsb-blocked-"));
  const previous = process.env.XDG_CONFIG_HOME;
  rmSync(join(configHome, "gentle-shell-bridge"), { recursive: true, force: true });
  writeFileSync(join(configHome, "gentle-shell-bridge"), "not a directory");
  try {
    assert.doesNotThrow(() => registerToolDesign(groupedDesign({ tools: ["grep"] })));
    assert.equal(resolveToolDesignSelection("grep").kind, "native", "the line keeps its own value");
  } finally {
    rmSync(join(configHome, "gentle-shell-bridge"), { force: true });
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    rmSync(blocked, { recursive: true, force: true });
  }
});

test("S4/BASELINE: disposing the design a tool's selection names resolves to `missing`", () => {
  const dispose = registerToolDesign(bashHeadingDesign);
  setToolDesignSelection("bash", "loon.bash-heading");
  assert.equal(resolveToolDesignSelection("bash").kind, "design");
  dispose();
  assert.deepEqual(
    resolveToolDesignSelection("bash"),
    { kind: "missing", id: "loon.bash-heading" },
    "the stored choice is not silently rewritten: it is reported",
  );
});

test("D3: a legacy value that names no design of the line is not migrated", () => {
  setToolDesignSelection("bash", "loon.elsewhere");
  registerToolDesign(groupedDesign({ tools: ["bash"] }));

  assert.equal(getToolDesignLineSelection("line", "tools"), TOOL_DESIGN_NATIVE);
  assert.deepEqual(readDesignStore().lines, {}, "nothing was written for the line");
});

test("S6/D4: a grouped design paints only the tools it names; a covered tool outside it draws the host's card", () => {
  registerToolDesign(
    groupedDesign({
      tools: ["bash"],
      apply: (lines: readonly string[]) => lines.map((line) => line.replace("$ ", "bash ")),
    }),
  );
  registerToolDesign(groupedDesign({ tools: ["write"], id: "loon.tools-write", label: "write activity" }));
  setToolDesignLineSelection("line", "tools", "loon.tools-activity");

  const bash = bashRenderers();
  const bashResolved = toolDesignResolver("bash", () => bash.renderers);
  assert.ok(bashResolved !== undefined);
  assert.deepEqual(renderThrough(bashResolved, "renderCall", 80).lines, DESIGNED_BASH_CARD);

  const write = writeRenderers();
  const writeResolved = toolDesignResolver("write", () => write.renderers);
  assert.ok(writeResolved !== undefined);
  assert.notEqual(writeResolved, write.renderers, "the line covers write, so its card is wrapped too");
  assert.deepEqual(
    renderThrough(writeResolved, "renderCall", 80).lines,
    WRITE_CARD,
    "not covered by the selected value: the host's own rows, byte for byte",
  );
});

test("D7: /bridge-status reports the line, its tools, each value's coverage and the line per tool", () => {
  registerToolDesign(groupedDesign({ tools: ["bash", "write"], id: "loon.tools-activity" }));
  registerToolDesign(groupedDesign({ tools: ["bash"], id: "loon.tools-complete", label: "complete" }));
  setToolDesignLineSelection("line", "tools", "loon.tools-complete");

  const snapshot = collectStatus();
  const designs = snapshot.toolDesigns;
  assert.ok(designs !== undefined);
  const line = designs.lines?.[0];
  assert.ok(line !== undefined, "a grouped line is reported");
  assert.equal(line.line, "tools");
  assert.equal(line.rowName, "Card tools");
  assert.deepEqual(line.tools, ["bash", "write"]);
  assert.deepEqual(
    line.values.map((value) => [value.id, value.label, value.covers]),
    [
      [TOOL_DESIGN_NATIVE, "default", ["bash", "write"]],
      ["loon.tools-activity", "activity", ["bash", "write"]],
      ["loon.tools-complete", "complete", ["bash"]],
    ],
  );
  assert.equal(designs.tools.find((entry) => entry.tool === "bash")?.line, "tools");
  assert.equal(
    designs.tools.find((entry) => entry.tool === "write")?.selection,
    "loon.tools-complete (not covered: the tool is not in this design's tools)",
  );

  const report = formatStatus(snapshot).join("\n");
  assert.match(report, /tool design lines: 1/u);
  assert.match(report, /- tools "Card tools": bash, write/u);
  assert.match(report, /loon\.tools-complete "complete": covers bash/u);
  assert.match(report, /bash: loon\.tools-complete, .*line "tools"/u);
});

test("PRESERVE: an ungrouped design's /bridge-status block keeps its exact shape", () => {
  registerToolDesign(bashHeadingDesign);
  const designs = collectStatus().toolDesigns;
  assert.ok(designs !== undefined);
  assert.equal(designs.lines, undefined, "no grouped line, no line report");
  assert.equal(designs.tools[0]?.line, undefined, "an ungrouped tool names no line");
  assert.match(formatStatus(collectStatus()).join("\n"), /- bash: native, wrapper not mounted$/mu);
});

// ---------------------------------------------------------------------------------------------
// S7–S11 — a line can own PART of a tool's calls (the scope)
// ---------------------------------------------------------------------------------------------

/** The consumer's own rule (`fileCardIdentity`): a path under `skills/` or `odd/`. */
const underSkillsOrOdd = (call: ToolDesignCall): boolean => {
  const args = call.args as { path?: unknown } | undefined;
  return typeof args?.path === "string" && /^(?:skills|odd)\//u.test(args.path);
};

/** ONE scope object per registry: S8 says every live registration of a line shares the same one. */
const WRITE_SCOPE: ToolDesignScope = {
  description: "paths under skills/ or odd/",
  matches: underSkillsOrOdd,
};

const pathScope = (description = "paths under skills/ or odd/"): ToolDesignScope => ({
  description,
  matches: underSkillsOrOdd,
});

/** The second line the consumer asked for: it claims `write` for the calls under `skills/`/`odd/`. */
const scopedWrite = (overrides: Partial<ToolDesignRegistration> = {}): ToolDesignRegistration => ({
  line: "diff",
  tools: ["write"],
  id: "loon.diff",
  label: "diff card",
  description: "draws a write as an IDE diff",
  scope: WRITE_SCOPE,
  apply: (lines: readonly string[]) => lines.map((line) => line.replace("✎", "DIFF")),
  ...overrides,
});

/** A scoped line that matches every call of its tool, for the ordering and cost cases. */
const everyCall = (): ToolDesignScope => ({ description: "every call", matches: () => true });

const scopedLine = (
  line: string,
  tool: string,
  id: string,
  label: string,
  scope: ToolDesignScope,
): ToolDesignRegistration => ({
  line,
  tools: [tool],
  id,
  label,
  scope,
  apply: (lines: readonly string[]) => [...lines],
});

test("S9: a scoped claim and the one unscoped claim of a tool live together, in both orders", () => {
  // Unscoped first, scoped second.
  registerToolDesign(writeBadgeDesign);
  registerToolDesign(scopedWrite());
  assert.deepEqual(
    toolDesignLines().map((line) => line.line),
    ["write", "diff"],
    "both lines are live and both claim write",
  );
  assert.deepEqual(getToolDesignConflicts(), [], "a scoped claim never conflicts with the unscoped one");

  // Scoped first, unscoped second: the same pair, registered the other way round.
  registerToolDesign(scopedLine("audit", "edit", "loon.audit", "audit card", everyCall()));
  registerToolDesign({
    tool: "edit",
    id: "loon.edit-badge",
    label: "edit badge",
    apply: (lines: readonly string[]) => [...lines],
  });
  assert.deepEqual(
    toolDesignLines().map((line) => line.line),
    ["write", "diff", "audit", "edit"],
    "the scoped claim first does not block the unscoped one either",
  );
  assert.deepEqual(getToolDesignConflicts(), []);
});

test("S2/S9: two UNSCOPED claims of one tool are still refused whole as `line`, both orders", () => {
  // A grouped unscoped line owns bash; an incoming legacy `Card bash` registration names it again.
  registerToolDesign(groupedDesign({ tools: ["bash"], id: "loon.tools-activity" }));
  assert.throws(
    () => registerToolDesign(bashHeadingDesign),
    /already belongs to the line "tools"/u,
  );
  assert.equal(getToolDesignConflicts().at(-1)?.kind, "line", "today's conflict kind is kept");

  // The other order: one unscoped legacy claim is live, an unscoped grouped line names it again.
  registerToolDesign(writeBadgeDesign);
  assert.throws(
    () => registerToolDesign(groupedDesign({ tools: ["write"], id: "loon.tools-write", label: "activity two" })),
    /already belongs to its own Card "write" line/u,
  );
  const conflict = getToolDesignConflicts().at(-1);
  assert.equal(conflict?.kind, "line");
  assert.equal(conflict?.tool, "write");
  assert.deepEqual(toolNamesWithDesigns(), ["bash", "write"], "nothing half-registered");
});

test("S7: an invalid scope refuses the WHOLE registration before anything is stored", () => {
  const invalidScopes: unknown[] = [
    null,
    "paths under skills/",
    42,
    ["paths"],
    {},
    { matches: () => true },
    { description: "   ", matches: () => true },
    { description: 7, matches: () => true },
    { description: "paths under skills/", matches: "yes" },
  ];
  for (const scope of invalidScopes) {
    assert.throws(
      () => registerToolDesign({ ...scopedWrite(), scope } as unknown as ToolDesignRegistration),
      (error: Error) => {
        assert.match(error.message, /"loon\.diff"/u, "the message names the design id");
        assert.match(error.message, /line "diff"/u, "and the subject");
        assert.match(error.message, /description/u, "and both members");
        assert.match(error.message, /matches/u);
        return true;
      },
    );
    assert.deepEqual(toolDesignLines(), [], "a refused registration never half-registers");
  }
  const conflicts = getToolDesignConflicts();
  assert.ok(conflicts.length >= 3, "each distinct refusal is recorded");
  for (const conflict of conflicts) {
    assert.equal(conflict.kind, "scope");
    assert.equal(conflict.tool, "diff", "a grouped refusal carries its line");
    assert.equal(conflict.id, "loon.diff");
  }
});

test("S7: a batch with one invalid scope registers none of it", () => {
  assert.throws(() =>
    registerToolDesign([
      writeBadgeDesign,
      { ...scopedWrite(), scope: { description: "", matches: () => true } },
    ]),
  );
  assert.deepEqual(toolNamesWithDesigns(), [], "the valid registration before the refused one is rolled back");
});

test("S7: a scope on the UNGROUPED shape is refused whole as `scope`, before anything is stored", () => {
  // An ungrouped registration IS the tool's own `Card write` line, and that line means every call of
  // `write` by definition: "only some calls" is the grouped shape.
  const ungrouped: ToolDesignRegistration = {
    tool: "write",
    id: "loon.skill-writes",
    label: "skill writes",
    scope: pathScope(),
    apply: (lines: readonly string[]) => [...lines],
  };
  assert.throws(
    () => registerToolDesign(ungrouped),
    (error: Error) => {
      assert.match(error.message, /"loon\.skill-writes"/u, "the message names the design id");
      assert.match(error.message, /tool "write"/u, "and the tool");
      assert.ok(
        error.message.includes("{ line, tools, scope, id, label, apply }"),
        "and the grouped shape that is how a design claims only some calls",
      );
      return true;
    },
  );
  assert.deepEqual(toolDesignLines(), [], "a refused registration never half-registers");
  assert.deepEqual(toolNamesWithDesigns(), [], "and stores no tool");
  const conflict = getToolDesignConflicts().at(-1);
  assert.equal(conflict?.kind, "scope", "the refusal is recorded under the `scope` kind");
  assert.equal(conflict?.tool, "write", "the tool is the line an ungrouped design would own");
  assert.equal(conflict?.id, "loon.skill-writes");

  // A batch is all-or-nothing around it too.
  assert.throws(() => registerToolDesign([writeBadgeDesign, ungrouped]));
  assert.deepEqual(toolNamesWithDesigns(), [], "the valid registration before the refused one is rolled back");
});

test("S8: one scope per line, and re-registering the same (line, id) may carry a fresh object", () => {
  const first = pathScope();
  registerToolDesign(scopedWrite({ scope: first }));
  // The same OBJECT joins the line: two values of one line, one switch, one scope.
  registerToolDesign(scopedWrite({ id: "loon.diff-two", label: "diff two", scope: first }));
  assert.equal(getToolDesignConflicts().length, 0);

  // A DIFFERENT scope object on the same line is a contradiction: refused whole and reported.
  assert.throws(
    () =>
      registerToolDesign(
        scopedWrite({ id: "loon.diff-three", label: "diff three", scope: pathScope("every write") }),
      ),
    /line is one switch/u,
  );
  const conflict = getToolDesignConflicts().at(-1);
  assert.equal(conflict?.kind, "scope", "the new conflict kind");
  assert.equal(conflict?.tool, "diff", "a grouped registration reports its line");
  assert.equal(conflict?.id, "loon.diff-three");
  assert.deepEqual(
    toolDesignLines()[0]?.designs.map((design) => design.id),
    ["loon.diff", "loon.diff-two"],
    "the refused registration joined nothing",
  );

  // Replacing its OWN entry with a fresh scope object is exempt, so a plugin may re-register itself.
  // (A line with more than one design still needs them all to agree, which is why this one is alone.)
  const reviewScope = pathScope("paths under review/");
  registerToolDesign(scopedLine("review", "edit", "loon.review", "review card", reviewScope));
  const fresh = pathScope("paths under review/");
  registerToolDesign(scopedLine("review", "edit", "loon.review", "review card", fresh));
  assert.equal(snapshotToolDesigns("edit")[0]?.scope, fresh, "the later registration is the live one");
  assert.equal(
    getToolDesignConflicts().filter((candidate) => candidate.kind === "scope").length,
    1,
    "only the genuine disagreement is recorded as a scope conflict",
  );
});

test("S10: a scope that does not match a call leaves the answer exactly as today", () => {
  registerToolDesign(scopedWrite());
  setToolDesignLineSelection("line", "diff", "loon.diff");

  assert.deepEqual(
    resolveToolDesignSelection("write", { path: "src/index.ts" }),
    { kind: "native" },
    "the only claim is scoped and declines: the host's own card",
  );
  assert.deepEqual(
    resolveToolDesignSelection("write"),
    { kind: "native" },
    "no args means no scoped candidate",
  );
  const matched = resolveToolDesignSelection("write", { path: "skills/card.md" });
  assert.ok(matched.kind === "design");
  assert.equal(matched.design.id, "loon.diff");
});

test("S10: a matching scoped line whose value is `native` DECLINES and the unscoped claim answers", () => {
  registerToolDesign(scopedWrite());
  registerToolDesign(writeBadgeDesign);
  setToolDesignSelection("write", "loon.write-badge");

  // Registering a scoped line must not change what `write` painted while the line sits at its default.
  const declined = resolveToolDesignSelection("write", { path: "skills/card.md" });
  assert.ok(declined.kind === "design");
  assert.equal(declined.design.id, "loon.write-badge");

  // The user selects the scoped value: it now wins for the calls it owns, and only those.
  setToolDesignLineSelection("line", "diff", "loon.diff");
  const owned = resolveToolDesignSelection("write", { path: "skills/card.md" });
  assert.ok(owned.kind === "design");
  assert.equal(owned.design.id, "loon.diff", "a scoped design wins over the unscoped claim");
  const outside = resolveToolDesignSelection("write", { path: "src/index.ts" });
  assert.ok(outside.kind === "design");
  assert.equal(outside.design.id, "loon.write-badge", "a call outside the scope is still the old answer");
});

test("S10: two scoped claims that match one call resolve by REGISTRATION ORDER", () => {
  // The one registered first wins when both would paint...
  registerToolDesign(scopedLine("diff", "write", "loon.diff", "diff card", everyCall()));
  registerToolDesign(scopedLine("audit", "write", "loon.audit", "audit card", everyCall()));
  setToolDesignLineSelection("line", "diff", "loon.diff");
  setToolDesignLineSelection("line", "audit", "loon.audit");
  const first = resolveToolDesignSelection("write", { path: "skills/a.md" });
  assert.ok(first.kind === "design");
  assert.equal(first.design.id, "loon.diff", "the earlier-registered line answers");

  // ...and a line that declines lets the next one answer.
  setToolDesignLineSelection("line", "diff", TOOL_DESIGN_NATIVE);
  const second = resolveToolDesignSelection("write", { path: "skills/a.md" });
  assert.ok(second.kind === "design");
  assert.equal(second.design.id, "loon.audit");

  // The mirror image: the other registration order answers the other way round.
  registerToolDesign(scopedLine("audit-edit", "edit", "loon.audit-edit", "audit edit", everyCall()));
  registerToolDesign(scopedLine("diff-edit", "edit", "loon.diff-edit", "diff edit", everyCall()));
  setToolDesignLineSelection("line", "audit-edit", "loon.audit-edit");
  setToolDesignLineSelection("line", "diff-edit", "loon.diff-edit");
  const mirrored = resolveToolDesignSelection("edit", { path: "odd/b.md" });
  assert.ok(mirrored.kind === "design");
  assert.equal(mirrored.design.id, "loon.audit-edit", "order is registration order, not name order");
});

test("S10: a scope that throws counts as 'does not match' and is recorded ONCE", () => {
  const hostile: ToolDesignScope = {
    description: "throws on every call",
    matches() {
      throw new Error("scope exploded");
    },
  };
  registerToolDesign(scopedWrite({ scope: hostile }));
  registerToolDesign(writeBadgeDesign);
  setToolDesignSelection("write", "loon.write-badge");
  setToolDesignLineSelection("line", "diff", "loon.diff");

  // Resolution never throws: the failing scope simply declines the call.
  const answer = resolveToolDesignSelection("write", { path: "skills/a.md" });
  assert.ok(answer.kind === "design", "the next candidate answers");
  assert.equal(answer.design.id, "loon.write-badge");
  resolveToolDesignSelection("write", { path: "skills/a.md" });
  resolveToolDesignSelection("write", { path: "odd/b.md" });
  assert.equal(resolveToolDesignSelection("write", { path: "skills/a.md" }).kind, "design");

  const failures = getToolDesignFailures();
  assert.equal(failures.length, 1, "one fact, not one per call");
  assert.equal(failures[0].tool, "write");
  assert.equal(failures[0].designId, "loon.diff");
  assert.match(failures[0].message, /scope exploded/u);
});

test("S10/S18: a thrown value that cannot be turned into text is REPORTED, never propagated", () => {
  // An error object with a NULL prototype: `String(...)` throws `Cannot convert object to primitive
  // value`, so a failure message built by stringifying the thrown value would escape the published
  // resolver as a crash. Reading it is part of never throwing (S18).
  const unprintable: ToolDesignScope = {
    description: "throws a value with no printable form",
    matches() {
      throw Object.assign(Object.create(null), { message: "rejected" });
    },
  };
  registerToolDesign(scopedWrite({ scope: unprintable }));
  setToolDesignLineSelection("line", "diff", "loon.diff");

  for (const path of ["skills/a.md", "odd/b.md"]) {
    assert.deepEqual(
      resolveToolDesignSelection("write", { path }),
      { kind: "native" },
      "the only claim declined the call, and building its failure never threw",
    );
  }

  const failures = getToolDesignFailures();
  assert.equal(failures.length, 1, "one fact per (tool, design id, message)");
  assert.equal(failures[0].designId, "loon.diff");
  assert.match(failures[0].message, /threw \(/u, "the failure says the scope threw");
  assert.doesNotMatch(
    failures[0].message,
    /Cannot convert object to primitive value/u,
    "the bridge's own crash never becomes part of the report",
  );
});

test("S10: `missing` and `not-covered` on the last candidate answer exactly as today", () => {
  registerToolDesign(scopedWrite());
  setToolDesignLineSelection("line", "diff", "loon.gone");
  assert.deepEqual(
    resolveToolDesignSelection("write", { path: "skills/a.md" }),
    { kind: "missing", id: "loon.gone" },
  );

  // A value of the line that does not paint this tool is `not-covered`, as on an unscoped line.
  registerToolDesign(scopedWrite({ tools: ["bash"], id: "loon.diff-bash", label: "diff bash" }));
  setToolDesignLineSelection("line", "diff", "loon.diff-bash");
  assert.deepEqual(
    resolveToolDesignSelection("write", { path: "skills/a.md" }),
    { kind: "not-covered", id: "loon.diff-bash" },
  );
});

test("S10: a live claim that DECLINES answers `native`, never a stale historical per-tool value", () => {
  // A session that predates lines leaves its value in the historical per-tool map; `write` has no
  // unscoped claim here, so that map is the only place an answer could be re-entered from.
  setToolDesignSelection("write", "loon.legacy-write");
  registerToolDesign(scopedWrite());
  setToolDesignLineSelection("line", "diff", "loon.diff");

  assert.deepEqual(
    resolveToolDesignSelection("write", { path: "src/index.ts" }),
    { kind: "native" },
    "the only live claim declined the call: the host's own card, not a value nobody selected",
  );
  assert.deepEqual(
    resolveToolDesignSelection("write"),
    { kind: "native" },
    "no args: the scoped claim is no candidate, and the tool still has a live claim",
  );
  assert.deepEqual(
    resolveToolDesignSelection("bash", { path: "src/index.ts" }),
    { kind: "native" },
    "a tool with no claim at all keeps reading its historical value, which is absent",
  );
  setToolDesignSelection("todo", "loon.legacy-todo");
  assert.deepEqual(
    resolveToolDesignSelection("todo"),
    { kind: "missing", id: "loon.legacy-todo" },
    "WITHOUT a live claim the historical value still answers, as S2 requires",
  );
});

test("S9: re-registering a scoped line as UNSCOPED cannot leave two unscoped claims alive", () => {
  // The reachable path: `x` claims `write` SCOPED, then `y` claims it UNSCOPED (allowed by S9).
  registerToolDesign(scopedLine("x", "write", "loon.x", "x card", pathScope()));
  registerToolDesign(groupedDesign({ line: "y", tools: ["write"], id: "loon.y", label: "y card" }));
  assert.deepEqual(getToolDesignConflicts(), [], "the pair S9 allows registered cleanly");

  // Now the SAME (line, id) as `x` re-registers UNSCOPED: S8 exempts the entry it replaces, but that
  // exemption must not skip the check against the OTHER unscoped owner.
  assert.throws(
    () =>
      registerToolDesign(
        groupedDesign({ line: "x", tools: ["write"], id: "loon.x", label: "x card" }),
      ),
    /already belongs to the line "y"/u,
  );
  const conflict = getToolDesignConflicts().at(-1);
  assert.equal(conflict?.kind, "line", "today's conflict kind and message are kept");
  assert.equal(conflict?.tool, "write");
  assert.equal(conflict?.id, "loon.x");
  assert.deepEqual(
    snapshotToolDesigns("write").map((design) => [design.id, design.scope === undefined]),
    [
      ["loon.x", false],
      ["loon.y", true],
    ],
    "exactly one unscoped claim of `write` is alive, and `x` kept the scope it declared",
  );
});

test("S10/PRESERVE: a one-argument resolve answers exactly as today for an unscoped registry", () => {
  registerToolDesign(writeBadgeDesign);
  assert.deepEqual(resolveToolDesignSelection("write"), { kind: "native" });

  setToolDesignSelection("write", "loon.write-badge");
  const design = resolveToolDesignSelection("write");
  assert.ok(design.kind === "design");
  assert.equal(design.design.id, "loon.write-badge");

  setToolDesignSelection("write", "loon.gone");
  assert.deepEqual(resolveToolDesignSelection("write"), { kind: "missing", id: "loon.gone" });
  assert.deepEqual(resolveToolDesignSelection("todo"), { kind: "native" }, "a tool with no design");

  // `not-covered` on the grouped shape that has always produced it.
  registerToolDesign(groupedDesign({ tools: ["bash", "grep"], id: "loon.tools-activity" }));
  registerToolDesign(groupedDesign({ tools: ["bash"], id: "loon.tools-bash", label: "complete" }));
  setToolDesignLineSelection("line", "tools", "loon.tools-bash");
  assert.deepEqual(resolveToolDesignSelection("grep"), {
    kind: "not-covered",
    id: "loon.tools-bash",
  });
});

test("S12: the resolver resolves with the call's args, so the scoped line draws the calls it owns", () => {
  const seen: ToolDesignCall[] = [];
  registerToolDesign({
    ...scopedWrite(),
    apply: (lines: readonly string[]) => lines.map((line) => line.replace("✿", "◆")),
    scope: {
      description: WRITE_SCOPE.description,
      matches(call: ToolDesignCall): boolean {
        seen.push(call);
        return underSkillsOrOdd(call);
      },
    },
  });
  registerToolDesign(writeBadgeDesign);
  setToolDesignLineSelection("line", "diff", "loon.diff");
  setToolDesignSelection("write", "loon.write-badge");

  const { renderers } = writeRenderers();
  const resolved = toolDesignResolver("write", () => renderers);
  assert.ok(resolved !== undefined);
  const render = (args: unknown, member: "renderCall" | "renderResult" = "renderCall"): string[] => {
    const renderer = resolved[member] as (...values: unknown[]) => FakeComponent;
    const component =
      member === "renderCall"
        ? renderer({}, THEME, { toolCallId: "call-1", args })
        : renderer({}, {}, THEME, { toolCallId: "call-1", args });
    return component.render(80);
  };

  const hostArgs = { path: "skills/card.md", content: "x" };
  assert.deepEqual(render(hostArgs), ["╭─ ◆ write ─╮", "│ ✎ src/index.ts", "╰───────────╯"]);
  assert.deepEqual(
    render(hostArgs, "renderResult"),
    ["╭─ ◆ write ─╮", "│ ok", "╰───────────╯"],
    "the call and the result halves are drawn by the SAME design",
  );
  assert.deepEqual(
    render({ path: "src/index.ts" }),
    ["╭─ ✿ write ─╮", "│ WRITE src/index.ts", "╰───────────╯"],
    "outside the scope the unscoped claim answers, exactly as before",
  );
  assert.deepEqual(render(undefined), ["╭─ ✿ write ─╮", "│ WRITE src/index.ts", "╰───────────╯"], "no render context: no scoped candidate");

  // The scope sees the CALL and nothing else, by reference, and never the card's `part`.
  assert.deepEqual(seen.length, 3, "evaluated when the host provided args, never without them");
  for (const call of seen) {
    assert.deepEqual(Object.keys(call).sort(), ["args", "tool"]);
    assert.equal(call.tool, "write");
  }
  assert.equal(seen[0].args, hostArgs, "args are forwarded by reference, never cloned");
});

test("S14: a tool with scoped claims lists every claiming line with its stored value and the scope", () => {
  // `write` is claimed by the unscoped legacy line AND by the scoped line: both are listed.
  registerToolDesign(writeBadgeDesign);
  registerToolDesign(scopedWrite());
  setToolDesignSelection("write", "loon.write-badge");
  setToolDesignLineSelection("line", "diff", "loon.diff");
  // `bash` is claimed by one unscoped line only: it keeps today's line exactly.
  registerToolDesign(groupedDesign({ tools: ["bash"], id: "loon.tools-activity" }));
  setToolDesignLineSelection("line", "tools", "loon.tools-activity");

  const designs = collectStatus().toolDesigns;
  assert.ok(designs !== undefined);
  const write = designs.tools.find((entry) => entry.tool === "write");
  assert.ok(write !== undefined);
  assert.equal(write.line, undefined, "a tool with scoped claims lists its lines instead of one");
  assert.deepEqual(write.claims, [
    { kind: "tool", line: "write", stored: "loon.write-badge" },
    { kind: "line", line: "diff", stored: "loon.diff", scope: WRITE_SCOPE.description },
  ]);

  const bash = designs.tools.find((entry) => entry.tool === "bash");
  assert.equal(bash?.line, "tools", "a tool claimed by one line prints as today");
  assert.equal(bash?.claims, undefined, "and gains no claims list");

  const report = formatStatus(collectStatus()).join("\n");
  assert.match(report, /tool "write": loon\.write-badge/u);
  assert.match(
    report,
    /line "diff": loon\.diff — scope: paths under skills\/ or odd\//u,
    "the scope says which calls that line owns",
  );
  assert.match(report, /- bash: loon\.tools-activity, .*line "tools"/u);
});

test("S14: a `scope` conflict and a scope's failure print like the other kinds, and status never throws", () => {
  const hostile: ToolDesignScope = {
    description: "throws on every call",
    matches() {
      throw new Error("scope exploded");
    },
  };
  registerToolDesign(scopedWrite({ scope: hostile }));
  setToolDesignLineSelection("line", "diff", "loon.diff");
  assert.throws(() =>
    registerToolDesign(scopedWrite({ id: "loon.diff-two", label: "diff two", scope: pathScope() })),
  );

  // The failure is recorded where resolution happens: one render pass of a card of that tool.
  const { renderers } = writeRenderers();
  const resolved = toolDesignResolver("write", () => renderers);
  assert.ok(resolved !== undefined);
  (resolved.renderCall as (...values: unknown[]) => FakeComponent)({}, THEME, {
    args: { path: "skills/a.md" },
  }).render(80);

  assert.doesNotThrow(() => collectStatus(), "the block never throws");
  const snapshot = collectStatus();
  assert.ok(snapshot.toolDesigns !== undefined);
  assert.equal(snapshot.toolDesigns.conflicts[0]?.kind, "scope");

  const report = formatStatus(snapshot).join("\n");
  assert.match(report, /tool design conflicts: 1/u);
  assert.match(report, /\(scope\)/u);
  assert.match(report, /tool design failures: 1/u);
  assert.match(report, /scope exploded/u);
  assert.doesNotThrow(() => formatStatus(collectStatus()));
});

// ---------------------------------------------------------------------------------------------
// S18 — the audit's robustness rules: a foreign slot, a one-line description, a boolean answer
// ---------------------------------------------------------------------------------------------

/** The process-global slot two copies of the bridge share (`src/tool-designs.ts`). */
const DESIGNS_SLOT = Symbol.for("gentle-shell-bridge.tool-designs.v1");

test("S18: a derived index left by an OLDER copy of the bridge is dropped, never trusted", () => {
  const host = globalThis as unknown as Record<symbol, unknown>;
  const previous = host[DESIGNS_SLOT];
  // The slot a plugin pinned to the PREVIOUS release warmed before the host was upgraded: the same
  // lists, and a derived index of the older SHAPE — no shape stamp and no claim map, because that
  // copy knew nothing about scopes — at the CURRENT revision, so the revision check alone trusts it.
  host[DESIGNS_SLOT] = {
    entries: [],
    conflicts: [],
    failures: [],
    selectionReads: 0,
    revision: 3,
    index: { revision: 3, owner: new Map(), lines: [], byKey: new Map(), designsByTool: new Map() },
  };
  try {
    // Every read site answers through a rebuilt index instead of reading a map nobody wrote.
    assert.deepEqual(
      resolveToolDesignSelection("write"),
      { kind: "native" },
      "resolve answers on a slot an older copy created",
    );
    assert.deepEqual(toolDesignClaims("write"), [], "the claim map is rebuilt, not read as undefined");

    // Registering is a read site too: it walks the claim map of every tool it names.
    registerToolDesign(scopedWrite());
    assert.deepEqual(
      toolDesignClaims("write").map((claim) => [claim.line, claim.stored, claim.scopeDescription]),
      [["diff", TOOL_DESIGN_NATIVE, WRITE_SCOPE.description]],
      "the claim the new registration made is on the rebuilt index",
    );

    // ...and `/bridge-status` lists a claim of every tool with a design, so it reads it as well.
    assert.doesNotThrow(() => formatStatus(collectStatus()));
  } finally {
    host[DESIGNS_SLOT] = previous;
  }
});

test("S18: a scope description carrying a line break is refused whole as `scope`", () => {
  for (const description of ["paths under skills/\nand odd/", "paths under skills/\rand odd/"]) {
    let message = "";
    assert.throws(
      () => registerToolDesign({ ...scopedWrite(), scope: { description, matches: underSkillsOrOdd } }),
      (error: Error) => {
        message = error.message;
        assert.match(message, /"loon\.diff"/u, "the message names the design id");
        assert.match(message, /line "diff"/u, "and the subject");
        assert.match(message, /one line/iu, "and that the description must be one line");
        assert.match(message, /menu and \/bridge-status row/u, "and why: it is rendered into a row");
        assert.ok(!/[\r\n]/u.test(message), "the refusal itself never carries the break into a row");
        return true;
      },
    );
    assert.deepEqual(toolDesignLines(), [], "nothing is registered");
    assert.deepEqual(toolNamesWithDesigns(), [], "and no tool is claimed");
    const conflict = getToolDesignConflicts().at(-1);
    assert.equal(conflict?.kind, "scope", "recorded under the `scope` kind");
    assert.equal(conflict?.tool, "diff", "a grouped refusal carries its line");
    assert.equal(conflict?.id, "loon.diff");
  }
});

test("S18: a scope that does not answer with a boolean owns no call, and is recorded ONCE", () => {
  /** A scope whose `matches` answers something else; a plugin is plain JavaScript. */
  const answering = (answer: unknown, description: string): ToolDesignScope => ({
    description,
    // SAFETY: the answer is not typed here on purpose — this is the check under test.
    matches: (() => answer) as unknown as ToolDesignScope["matches"],
  });

  registerToolDesign(writeBadgeDesign);
  setToolDesignSelection("write", "loon.write-badge");
  // A paint cannot await, so a scope that cannot answer NOW has not answered.
  registerToolDesign(
    scopedLine("later", "write", "loon.later", "later card", answering(Promise.resolve(false), "answers later")),
  );
  registerToolDesign(
    scopedLine("stringy", "write", "loon.stringy", "stringy card", answering("yes", "answers yes")),
  );
  registerToolDesign(
    scopedLine("falsey", "write", "loon.falsey", "falsey card", answering(undefined, "answers nothing")),
  );
  // A scope that answers `false` IS answering: it owns no call and records nothing.
  registerToolDesign(
    scopedLine("honest", "write", "loon.honest", "honest card", {
      description: "matches nothing",
      matches: () => false,
    }),
  );

  for (const path of ["skills/a.md", "odd/b.md"]) {
    const answer = resolveToolDesignSelection("write", { path });
    assert.ok(answer.kind === "design", "resolution never throws and the next candidate answers");
    assert.equal(answer.design.id, "loon.write-badge", "the unscoped claim still owns the call");
  }

  const failures = getToolDesignFailures();
  assert.deepEqual(
    failures.map((failure) => failure.designId),
    ["loon.later", "loon.stringy", "loon.falsey"],
    "one fact per design that could not answer, never one per call, and none for a real false",
  );
  const [later, stringy, falsey] = failures;
  assert.match(later.message, /answered with object/u, "the message names what it returned");
  assert.match(stringy.message, /answered with string/u);
  assert.match(falsey.message, /answered with undefined/u);
  for (const failure of failures) {
    assert.equal(failure.tool, "write");
    assert.match(failure.message, /boolean/u);
    assert.match(failure.message, /paint cannot await/u);
  }
});

test("S18: a scope that returns a REJECTING promise never becomes an unhandled rejection", async () => {
  // A plugin bug must not take the host down: a host that treats an unhandled rejection as fatal would
  // crash on a paint the bridge already declined. The rejection is swallowed and the failure recorded.
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    registerToolDesign(writeBadgeDesign);
    setToolDesignSelection("write", "loon.write-badge");
    registerToolDesign(
      scopedLine("exploding", "write", "loon.exploding", "exploding card", {
        description: "answers asynchronously and rejects",
        // A plugin bug in plain JavaScript: the type says boolean, the runtime hands back a promise.
        matches: (() => Promise.reject(new Error("scope exploded in a promise"))) as never,
      }),
    );
    const answer = resolveToolDesignSelection("write", { path: "skills/a.md" });
    assert.ok(answer.kind === "design", "the call falls through to the unscoped claim");
    assert.equal(answer.design.id, "loon.write-badge");
    // Two macrotask turns: an unhandled rejection is reported on the second one in Node.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(seen, [], "the declined promise never reached the process as unhandled");
    assert.deepEqual(
      getToolDesignFailures().map((failure) => failure.designId),
      ["loon.exploding"],
      "the plugin bug is reported once, as the reason the line declined",
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});


test("S18: a thenable whose `then` RETURNS a rejecting promise never leaks it", async () => {
  // An `async then` cannot throw to its caller: it REJECTS the promise it returns. Draining the value
  // the bridge was handed is therefore not enough — the value the `then` CALL returned has to be
  // drained too, or `--unhandled-rejections=strict` takes the host down on a paint already declined.
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    registerToolDesign(writeBadgeDesign);
    setToolDesignSelection("write", "loon.write-badge");
    registerToolDesign(
      scopedLine("async-then", "write", "loon.async-then", "async then card", {
        description: "answers with a thenable that explodes asynchronously",
        // A plugin bug in plain JavaScript: `async then() { throw … }` rejects what IT returns.
        matches: (() => ({
          async then(): Promise<void> {
            throw new Error("async then failed");
          },
        })) as unknown as ToolDesignScope["matches"],
      }),
    );

    const answer = resolveToolDesignSelection("write", { path: "skills/a.md" });
    assert.ok(answer.kind === "design", "the call falls through to the unscoped claim");
    assert.equal(answer.design.id, "loon.write-badge");
    // Two macrotask turns: an unhandled rejection is reported on the second one in Node.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(seen, [], "the promise the async `then` returned never reached the process");
    assert.deepEqual(
      getToolDesignFailures().map((failure) => failure.designId),
      ["loon.async-then"],
      "the plugin bug is reported once, as the reason the line declined",
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

// ---------------------------------------------------------------------------------------------
// S18/S10, round two — a value that cannot be inspected, and a line order that survives disposal
// ---------------------------------------------------------------------------------------------

test("S18: a thenable whose `then` THROWS is declined every time and never throws", () => {
  /** A plugin bug in plain JavaScript: an object that pretends to be a promise, and explodes. */
  const malformed: ToolDesignScope = {
    description: "pretends to be a promise",
    matches: (() => ({
      then() {
        throw new Error("then exploded");
      },
    })) as unknown as ToolDesignScope["matches"],
  };
  registerToolDesign(scopedLine("broken", "write", "loon.broken", "broken card", malformed));
  setToolDesignLineSelection("line", "broken", "loon.broken");

  // Draining the thenable inspected plugin code: whatever it does when it is inspected, the call is
  // already declined and resolution never throws.
  for (const path of ["skills/a.md", "odd/b.md"]) {
    assert.deepEqual(
      resolveToolDesignSelection("write", { path }),
      { kind: "native" },
      "the malformed answer owns no call, and resolution never throws",
    );
  }

  const failures = getToolDesignFailures();
  assert.equal(failures.length, 1, "one fact per (tool, design id, message), not one per call");
  assert.equal(failures[0].tool, "write");
  assert.equal(failures[0].designId, "loon.broken");
  assert.match(failures[0].message, /answered with object/u);
  assert.match(failures[0].message, /boolean/u);
});

test("S18: a thenable whose `then` cannot even be READ is declined without throwing", () => {
  const unreadable = Object.defineProperty({}, "then", {
    configurable: true,
    get() {
      throw new Error("then getter exploded");
    },
  });
  const hostile: ToolDesignScope = {
    description: "answers with a value that explodes when inspected",
    matches: (() => unreadable) as unknown as ToolDesignScope["matches"],
  };
  registerToolDesign(scopedLine("unreadable", "write", "loon.unreadable", "unreadable card", hostile));
  setToolDesignLineSelection("line", "unreadable", "loon.unreadable");

  for (const path of ["skills/a.md", "skills/a.md"]) {
    assert.deepEqual(
      resolveToolDesignSelection("write", { path }),
      { kind: "native" },
      "reading `then` is inspection too: the decline stands and nothing reaches the host",
    );
  }

  const failures = getToolDesignFailures();
  assert.equal(failures.length, 1, "the already-recorded failure is the whole report");
  assert.equal(failures[0].designId, "loon.unreadable");
  assert.match(failures[0].message, /answered with object/u);
});

test("S10/S2: a line keeps its CLAIM order after one of its values is disposed", () => {
  // `alpha` appears first, `beta` second, then `alpha` gains a SECOND value. Disposing `alpha`'s
  // founding value must not promote `beta`: `alpha` never stopped claiming the tool. Claim PRECEDENCE
  // is creation order (S10); DISPLAY order is the first LIVE entry (S2) and is asserted in the rows.
  const alphaScope = everyCall();
  const disposeFounding = registerToolDesign(
    scopedLine("alpha", "write", "loon.alpha", "alpha card", alphaScope),
  );
  registerToolDesign(scopedLine("beta", "write", "loon.beta", "beta card", everyCall()));
  registerToolDesign(scopedLine("alpha", "write", "loon.alpha-two", "alpha two", alphaScope));
  setToolDesignLineSelection("line", "alpha", "loon.alpha-two");
  setToolDesignLineSelection("line", "beta", "loon.beta");

  const lineOrder = (): string[] => toolDesignLines().map((line) => line.line);
  const claimOrder = (): string[] => toolDesignClaims("write").map((claim) => claim.line);
  const winner = (): string => {
    const answer = resolveToolDesignSelection("write", { path: "skills/a.md" });
    assert.ok(answer.kind === "design", "both lines paint this call, so a design must answer");
    return answer.design.id;
  };

  assert.equal(winner(), "loon.alpha-two", "the earlier line wins while both values are live");
  assert.deepEqual(lineOrder(), ["alpha", "beta"]);
  assert.deepEqual(claimOrder(), ["alpha", "beta"]);

  disposeFounding();

  assert.equal(winner(), "loon.alpha-two", "alpha's remaining value still wins over beta");
  assert.deepEqual(
    lineOrder(),
    ["beta", "alpha"],
    "DISPLAY order follows the first LIVE entry, so disposing alpha's founding value moves it",
  );
  assert.deepEqual(claimOrder(), ["alpha", "beta"], "PRECEDENCE is untouched: the claim list of the tool");
  assert.deepEqual(
    toolDesignClaims("write").map((claim) => [claim.line, claim.stored]),
    [
      ["alpha", "loon.alpha-two"],
      ["beta", "loon.beta"],
    ],
    "each line keeps its own stored value",
  );
});
