/**
 * The row-name shape (N7–N9): one vocabulary, enforced instead of trusted.
 *
 * A row name is what a user reads where a setting line's name goes — an entry provider's
 * `choice.setting`, or the label of the row that provider, a section or a card style contributes.
 * The host names its own rows in one to three plain words (`Card style`, `stats`); the example read
 * `Bash card → Bash rendering`, a breadcrumb with an arrow and a repeated qualifier. Third instance
 * of one class of defect, so the rule lives in one place and BOTH boundaries apply it: a
 * registration (section, card style) and a menu build (provider rows).
 *
 * These tests pin the rule itself, the rejection everywhere it can happen, the derived names that
 * can therefore never violate it, and the example's corrected row. They also pin that nothing is
 * rewritten: the offending string is reported verbatim and the row is simply absent.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishBridgeApi, resetBridgeApiForTests } from "../src/api.ts";
import { armBridge } from "../src/arm.ts";
import {
  registerCardStyle,
  registerRows,
  registerSection,
  resetBusForTests,
  resetCardStylesForTests,
  resetSectionsForTests,
  snapshotCardStyles,
  snapshotSections,
} from "../src/bus.ts";
import { installCardStyleRows } from "../src/card-style-rows.ts";
import { HOST_CARD_STYLE_SETTING } from "../src/card-style-line.ts";
import { disableCaptureBackend, resetCaptureStateForTests } from "../src/capture.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import {
  cardStyleRowLabelText,
  sectionRowLabelText,
  sectionRowLabels,
} from "../src/row-labels.ts";
import {
  MAX_ROW_NAME_WORDS,
  ROW_NAME_MARKS,
  getRowNameRejections,
  resetRowNameRejectionsForTests,
  rowNameProblem,
} from "../src/row-names.ts";
import { getLastRowBuild, resetRowBuildStateForTests } from "../src/rows.ts";
import { installSectionRows } from "../src/sections-rows.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { CardFrame, CustomizeRow, SidebarSection } from "../src/types.ts";
import { createFakeHost, type FakeHost } from "./fake-host.ts";

const MARK_RULE =
  'a row name is one to three plain words with no arrow, colon, dot, pipe, slash or bracket';
const WORD_RULE = "a row name is one to three plain words";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-row-names-"));
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
  resetRowNameRejectionsForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetRowBuildStateForTests();
  resetNoticesForTests();
  resetStoreStateForTests();
  disableCaptureBackend();
});

const frame = (): CardFrame => ({
  top: (ctx) => "▛".repeat(ctx.width),
  line: (ctx) => ctx.text,
  bottom: (ctx) => "▙".repeat(ctx.width),
});

const section = (id: string, extra: Partial<SidebarSection> = {}): SidebarSection => ({
  id,
  title: id.toUpperCase(),
  lines: () => [`body ${id}`],
  ...extra,
});

const menuHost = (): FakeHost => {
  const host = createFakeHost();
  armBridge(host.ui);
  return host;
};

const sectionsHost = (): FakeHost => {
  installSectionRows();
  return menuHost();
};

const rowsOfLastBuild = (providerId: string): CustomizeRow[] =>
  getLastRowBuild()?.find((record) => record.providerId === providerId)?.rows ?? [];

/** A provider's toggle: two consecutive rows sharing the line name. */
const toggle = (setting: string, label: string, values: [string, string]): CustomizeRow[] =>
  values.map((value) => ({
    category: "Cards",
    label,
    choice: { setting, value, current: () => value === values[0] },
    action: () => {},
  }));

// ---------------------------------------------------------------------------------------------
// The rule: each mark, and the word limit (N7)
// ---------------------------------------------------------------------------------------------

test("every structural mark is rejected, named in the reason with the rule it broke", () => {
  // The list is the documented one: an arrow, a colon, a dot, a pipe, a slash, a bracket. Each is
  // checked inside an otherwise valid two-word name, so the mark is the only reason.
  const expected = new Map<string, string>();
  for (const mark of [
    "→", "←", "↑", "↓",
    ":", ".", "|", "/", "\\",
    "[", "]", "(", ")", "{", "}",
  ]) {
    expected.set(mark, `it contains ${JSON.stringify(mark)}; ${MARK_RULE}`);
  }

  for (const [mark, reason] of expected) {
    assert.ok(ROW_NAME_MARKS.includes(mark), `${mark} is part of the documented mark list`);
    assert.deepEqual(
      rowNameProblem(`Bash ${mark} rendering`),
      { rule: "mark", reason },
      `a name carrying ${mark} is rejected`,
    );
  }

  // The observed bad names, verbatim.
  assert.deepEqual(rowNameProblem("Bash card → Bash rendering"), {
    rule: "mark",
    reason: `it contains "→"; ${MARK_RULE}`,
  });
  assert.deepEqual(rowNameProblem("Bash card: rendering"), {
    rule: "mark",
    reason: `it contains ":"; ${MARK_RULE}`,
  });
});

test("a name is one to three plain words, and the limit is exact", () => {
  assert.equal(rowNameProblem("Bash rendering"), undefined);
  assert.equal(rowNameProblem("Bash"), undefined, "one word is a row name");
  assert.equal(rowNameProblem("Bash card rendering"), undefined, "three words are the limit");
  assert.equal(rowNameProblem("  Bash   rendering  "), undefined, "runs of spaces are not words");

  assert.deepEqual(rowNameProblem("Bash card rendering extra"), {
    rule: "words",
    reason: `it has 4 words; ${WORD_RULE}`,
  });
  assert.deepEqual(rowNameProblem(""), {
    rule: "words",
    reason: `it has 0 words; ${WORD_RULE}`,
  });
  assert.deepEqual(rowNameProblem("   "), {
    rule: "words",
    reason: `it has 0 words; ${WORD_RULE}`,
  });
  assert.equal(MAX_ROW_NAME_WORDS, 3, "the documented limit");
});

// ---------------------------------------------------------------------------------------------
// An entry provider's line name and row label (N8)
// ---------------------------------------------------------------------------------------------

test("a provider's line name with an arrow is rejected: absent from the rows and from the build", () => {
  const providerId = "loon.banner-source";
  registerRows({
    id: providerId,
    category: "Cards",
    rows: () => toggle("Loon → Banner source", "Loon banner source", ["activity", "output"]),
  });
  const host = menuHost();

  host.buildMenu();

  assert.deepEqual(host.toggleLines(), [], "no line reached the renderer");
  assert.equal(
    host.liveRows().some((row) => row.choice?.setting === "Loon → Banner source"),
    false,
    "the rejected rows were not injected into the host's array",
  );
  assert.deepEqual(rowsOfLastBuild(providerId), [], "and the build's own record has no row");
  assert.deepEqual(getRowNameRejections(), [
    {
      surface: "rows",
      id: providerId,
      field: "line name",
      value: "Loon → Banner source",
      rule: "mark",
      reason: `it contains "→"; ${MARK_RULE}`,
    },
  ]);
  assert.ok(
    formatStatus(collectStatus()).includes(
      `  - rows "${providerId}" line name "Loon → Banner source": it contains "→"; ${MARK_RULE} ` +
        "(rejected, never rewritten)",
    ),
    formatStatus(collectStatus()).join("\n"),
  );
});

test("a provider's row label with a colon is rejected, and its siblings still render", () => {
  const providerId = "loon.banner-source";
  registerRows({
    id: providerId,
    category: "Cards",
    rows: () => [
      ...toggle("Loon banner source", "Loon: banner source", ["activity", "output"]),
      ...toggle("Loon banner count", "Loon banner count", ["one", "two"]),
    ],
  });
  const host = menuHost();

  host.buildMenu();

  assert.deepEqual(
    host.toggleLines(),
    ["Loon banner count ● one ○ two"],
    "only the rejected line is absent; the provider's good rows are untouched",
  );
  assert.equal(
    host.liveRows().some((row) => row.choice?.setting === "Loon banner source"),
    false,
  );
  assert.deepEqual(
    rowsOfLastBuild(providerId).map((row) => row.choice?.setting),
    ["Loon banner count", "Loon banner count"],
    "the effective set holds the good rows only",
  );
  assert.deepEqual(getRowNameRejections(), [
    {
      surface: "rows",
      id: providerId,
      field: "row label",
      value: "Loon: banner source",
      rule: "mark",
      reason: `it contains ":"; ${MARK_RULE}`,
    },
  ]);
});

test("a provider line name over the word limit is rejected with the count", () => {
  const providerId = "loon.verbose";
  registerRows({
    id: providerId,
    category: "Cards",
    rows: () => toggle("Loon banner source activity", "Loon banner", ["on", "off"]),
  });
  const host = menuHost();

  host.buildMenu();

  assert.deepEqual(host.toggleLines(), []);
  assert.deepEqual(getRowNameRejections(), [
    {
      surface: "rows",
      id: providerId,
      field: "line name",
      value: "Loon banner source activity",
      rule: "words",
      reason: `it has 4 words; ${WORD_RULE}`,
    },
  ]);
});

// ---------------------------------------------------------------------------------------------
// Sections and card styles (N8)
// ---------------------------------------------------------------------------------------------

test("a section whose rowLabel breaks the shape is not stored, and /bridge-status says why", () => {
  registerSection(section("loon.music", { title: "MUSIC", rowLabel: "Music: now playing" }));

  assert.deepEqual(snapshotSections(), [], "a rejected registration is never stored");
  const host = sectionsHost();
  host.buildMenu();
  assert.deepEqual(host.toggleLines(), [], "and it never reaches a row");
  assert.deepEqual(getRowNameRejections(), [
    {
      surface: "section",
      id: "loon.music",
      field: "row label",
      value: "Music: now playing",
      rule: "mark",
      reason: `it contains ":"; ${MARK_RULE}`,
    },
  ]);
  assert.ok(
    formatStatus(collectStatus()).includes(
      '  - section "loon.music" row label "Music: now playing": it contains ":"; ' +
        `${MARK_RULE} (rejected, never rewritten)`,
    ),
    formatStatus(collectStatus()).join("\n"),
  );
});

test("a card style whose rowLabel breaks the shape is not registered and never reaches the line", () => {
  registerCardStyle({
    id: "loon.cute",
    label: "cute",
    rowLabel: "Cute → card",
    frame: frame(),
  });

  assert.deepEqual(snapshotCardStyles(), [], "a rejected style is never stored");
  installCardStyleRows();
  const host = createFakeHost({
    rows: [
      { category: "Cards", label: "Card bash: builtin", action: () => {} },
      { category: "Cards", label: "Card output: builtin", action: () => {} },
      {
        category: "Cards",
        label: () => "Card style: neon",
        choice: { setting: HOST_CARD_STYLE_SETTING, value: "neon", current: () => false },
        action: async () => {},
      },
      {
        category: "Cards",
        label: () => "Card style: float",
        choice: { setting: HOST_CARD_STYLE_SETTING, value: "float", current: () => true },
        action: async () => {},
      },
    ],
  });
  armBridge(host.ui);
  host.buildMenu();

  assert.deepEqual(host.toggleLines(), ["Card style ○ neon ● float"], "the host's line is unchanged");
  assert.deepEqual(getRowNameRejections(), [
    {
      surface: "card style",
      id: "loon.cute",
      field: "row label",
      value: "Cute → card",
      rule: "mark",
      reason: `it contains "→"; ${MARK_RULE}`,
    },
  ]);
});

// ---------------------------------------------------------------------------------------------
// Derivation can never produce a rejected value (N8)
// ---------------------------------------------------------------------------------------------

test("a derived row label always conforms: marks become word breaks, long titles are clamped", () => {
  const derived = [
    sectionRowLabelText({ title: "BASH CARD → STATUS" }),
    sectionRowLabelText({ title: "MUSIC PLAYER NOW PLAYING TODAY" }),
    sectionRowLabelText({ title: "···" }),
    cardStyleRowLabelText({ label: "Cute → card | frame" }),
    cardStyleRowLabelText({ label: "a very long style label with many words" }),
    cardStyleRowLabelText({ label: "···" }),
  ];

  for (const name of derived) {
    assert.equal(rowNameProblem(name), undefined, `${JSON.stringify(name)} must conform`);
  }
  assert.deepEqual(derived, [
    "bash card status",
    "music player now",
    "section",
    "cute card frame",
    "a very long",
    "card style",
  ]);
});

test("a collision suffix keeps a derived name inside the word limit", () => {
  const labels = sectionRowLabels([
    section("loon.one", { title: "MUSIC PLAYER NOW PLAYING" }),
    section("loon.two", { title: "MUSIC PLAYER NOW PLAYING AGAIN" }),
  ]);

  assert.deepEqual(
    labels.map((entry) => [entry.label, entry.collision]),
    [
      ["music player now", undefined],
      ["music player 2", "music player now"],
    ],
    "the ordinal replaces the base's last word instead of growing the name",
  );
  for (const entry of labels) {
    assert.equal(rowNameProblem(entry.label), undefined, `${entry.label} must conform`);
  }
});

test("PRESERVE: a conforming provider row renders exactly as before", () => {
  registerRows({
    id: "loon.banner-source",
    category: "Cards",
    rows: () => toggle("Loon banner source", "Loon banner source", ["activity", "output"]),
  });
  const host = menuHost();

  host.buildMenu();

  assert.deepEqual(host.toggleLines(), ["Loon banner source ● activity ○ output"]);
  assert.equal(
    host.rendered().includes("Loon banner source"),
    true,
    "the row label is carried through unchanged",
  );
  assert.deepEqual(getRowNameRejections(), [], "a conforming row records nothing");
});

// ---------------------------------------------------------------------------------------------
// The example (N7, N9)
// ---------------------------------------------------------------------------------------------

type SessionHandler = (event: unknown, ctx: { hasUI?: boolean; ui?: unknown }) => void;

interface FakePi {
  on?: (event: string, handler: SessionHandler) => void;
  registerToolRenderer?: (resolver: unknown) => void;
}

test("the example's row reads `Bash rendering`, and its old arrow/colon strings are gone", async () => {
  publishBridgeApi();
  const sessionHandlers: SessionHandler[] = [];
  const pi: FakePi = {
    registerToolRenderer: () => {},
    on(_event, handler) {
      sessionHandlers.push(handler);
    },
  };

  const specifier = new URL("../examples/bash-card.ts?row-name", import.meta.url).href;
  const init = ((await import(specifier)) as { default: (fakePi: FakePi) => () => void }).default;
  init(pi);
  const ui = { notify: () => {} };
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });

  const host = menuHost();
  host.buildMenu();

  assert.ok(
    host.toggleLines().includes("Bash rendering ● default ○ tool"),
    `the example's line is a row name: ${host.toggleLines().join(" | ")}`,
  );
  assert.ok(host.rendered().includes("Bash rendering"), "and so is its row label");

  const visible = [...host.rendered(), ...host.toggleLines()].join("\n");
  assert.equal(visible.includes("Bash card"), false, "no `Bash card` qualifier survives");
  assert.equal(visible.includes("Bash card:"), false, "no colon form survives");
  assert.equal(visible.includes("Bash card → Bash rendering"), false, "no arrow form survives");
  assert.deepEqual(getRowNameRejections(), [], "the example's own rows are accepted");
});
