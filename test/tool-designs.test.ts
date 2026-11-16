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
  toolDesignLines,
  toolNamesWithDesigns,
} from "../src/tool-designs.ts";
import type { ToolDesignContext, ToolDesignRegistration } from "../src/types.ts";
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

