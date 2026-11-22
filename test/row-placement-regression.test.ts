/**
 * T4 regression cases from independent verification (S4–S6).
 *
 * Each case below is a defect the verifier reproduced against the T1–T3 slices: a provider's
 * DECLARED category used as the block boundary, an unplaced provider moved because another one opted
 * in, rollback by identity deleting a host row, a partially applied splice over a read-only index,
 * and `/bridge-status` printing the plan instead of the landing a frozen array produced.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { registerRows, resetBusForTests } from "../src/bus.ts";
import { getCaptureDiagnostics, installCaptureBackend, resetCaptureStateForTests } from "../src/capture.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import type { CustomizeRow } from "../src/types.ts";
import { createFakeHost } from "./fake-host.ts";

const labelText = (row: CustomizeRow): string =>
  typeof row.label === "function" ? row.label() : (row.label ?? "");

const labels = (rows: readonly CustomizeRow[]): string[] => rows.map(labelText);

const page = (rows: readonly CustomizeRow[], category: string): string[] =>
  rows
    .filter((row) => (row.category ?? "Settings") === category)
    .map(labelText);

const hostRows = (): CustomizeRow[] => [
  { category: "Cards", label: "Card bash: builtin", action: () => {} },
  { category: "Cards", label: "Card output: builtin", action: () => {} },
  { category: "Banner", label: "Banner: builtin", action: () => {} },
  { category: "Layout", label: "Layout: builtin", action: () => {} },
];

/** A host that maps its rows to labels but never derives categories: the late path injects. */
const lateOnlyHost = (rows: CustomizeRow[]) => {
  const ui = {
    custom: (factory: (ui: unknown, theme: unknown, ...rest: unknown[]) => unknown): unknown =>
      factory(ui, undefined),
  };
  return {
    rows,
    ui,
    build: (): unknown =>
      ui.custom(() => {
        rows.map((row) => row.label);
        return { invalidate: () => {} };
      }),
  };
};

test.beforeEach(() => {
  resetBusForTests();
  resetCaptureStateForTests();
});

test("a row's own category is its block boundary, not the provider's declared category", () => {
  const pair = (label: string, value: string): CustomizeRow => ({
    category: "Cards",
    label,
    action: () => {},
    choice: { setting: "Pair", value, current: () => value === "first", applyOnMove: false },
  });
  // Cards rows are not contiguous in the host array: the renderer still shows one Cards page.
  const rows: CustomizeRow[] = [
    pair("First value", "first"),
    { category: "Banner", label: "Host banner", action: () => {} },
    pair("Second value", "second"),
    { category: "Layout", label: "Host layout", action: () => {} },
  ];
  const host = lateOnlyHost(rows);
  registerRows({
    id: "loon.plain",
    // The provider declares Banner, but the row it contributes belongs to Cards.
    category: "Banner",
    placement: "start",
    rows: () => [{ category: "Cards", label: "Plain row", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  host.build();

  const cards = page(rows, "Cards");
  assert.deepEqual(cards, ["Plain row", "First value", "Second value"]);
  const pairIndices = cards
    .map((label, index) => (label === "First value" || label === "Second value" ? index : -1))
    .filter((index) => index !== -1);
  assert.equal(pairIndices[1], (pairIndices[0] ?? 0) + 1, "the rendered Cards pair is never split");
});

test("a provider that opts into nothing keeps the pre-feature tail append", () => {
  const rows = hostRows();
  const host = lateOnlyHost(rows);
  registerRows({
    id: "loon.top",
    category: "Cards",
    placement: "start",
    rows: () => [{ label: "Start row", action: () => {} }],
  });
  registerRows({
    id: "loon.plain",
    category: "Cards",
    rows: () => [{ label: "Plain row", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  host.build();

  assert.deepEqual(labels(rows), [
    "Start row",
    "Card bash: builtin",
    "Card output: builtin",
    "Banner: builtin",
    "Layout: builtin",
    "Plain row",
  ]);
  assert.deepEqual(page(rows, "Cards"), ["Start row", "Card bash: builtin", "Card output: builtin", "Plain row"]);
});

test("unplaced pages keep their subscription order when another provider opts in", () => {
  const rows = hostRows();
  const host = createFakeHost({ rows });
  registerRows({
    id: "loon.top",
    category: "Cards",
    placement: "start",
    rows: () => [{ label: "Top row", action: () => {} }],
  });
  registerRows({
    id: "loon.zeta",
    category: "Zeta page",
    rows: () => [{ label: "Zeta row", action: () => {} }],
  });
  registerRows({
    id: "loon.alpha",
    category: "Alpha page",
    rows: () => [{ label: "Alpha row", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  host.buildMenu();

  assert.deepEqual([...new Set(host.categories())], [
    "Cards",
    "Banner",
    "Layout",
    "Zeta page",
    "Alpha page",
  ]);
});

test("with no provider opting in, pages keep the pre-feature tail order", () => {
  const rows = hostRows();
  const host = createFakeHost({ rows });
  registerRows({
    id: "loon.zeta",
    category: "Zeta page",
    rows: () => [{ label: "Zeta row", action: () => {} }],
  });
  registerRows({
    id: "loon.alpha",
    category: "Alpha page",
    rows: () => [{ label: "Alpha row", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  host.buildMenu();

  assert.deepEqual([...new Set(host.categories())], [
    "Cards",
    "Banner",
    "Layout",
    "Zeta page",
    "Alpha page",
  ]);
});

test("rollback restores a host row object that a provider handed back", async () => {
  const shared: CustomizeRow = {
    category: "Cards",
    label: "Shared row",
    action: () => {},
    choice: { setting: "Shared setting", value: "on", current: () => true, applyOnMove: false },
  };
  const rows: CustomizeRow[] = [
    shared,
    { category: "Cards", label: "Card tail", action: () => {} },
    { category: "Banner", label: "Banner: builtin", action: () => {} },
    { category: "Layout", label: "Layout: builtin", action: () => {} },
  ];
  const host = createFakeHost({ rows, factoryResult: "promise" });
  registerRows({
    id: "loon.shared",
    category: "Cards",
    rows: () => [shared],
  });
  installCaptureBackend(host.ui);
  const before = [...rows];

  await host.buildMenu();

  assert.equal(rows.length, before.length, "same length");
  assert.ok(
    rows.every((row, index) => row === before[index]),
    "the host's own row objects come back in the host's own order",
  );
});

test("a read-only index skips the move instead of half-applying it", () => {
  const rows = hostRows();
  Object.defineProperty(rows, "1", {
    value: rows[1],
    writable: false,
    enumerable: true,
    configurable: true,
  });
  const host = lateOnlyHost(rows);
  registerRows({
    id: "loon.top",
    category: "Cards",
    placement: "start",
    rows: () => [{ label: "Placed row", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  assert.doesNotThrow(() => host.build());

  assert.deepEqual(labels(rows), [
    "Card bash: builtin",
    "Card output: builtin",
    "Banner: builtin",
    "Layout: builtin",
    "Placed row",
  ]);
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, { kind: "injected", injectedRows: 1 });

  const placement = collectStatus().providers[0]?.placement;
  assert.equal(placement?.requested, "start");
  assert.equal(placement?.landed, "end");
  assert.match(placement?.reason ?? "", /read-only|would not accept|planned write/);
});

test("a frozen array after the provisional injection reports the landing it really got", () => {
  const rows = hostRows();
  const ui = {
    custom: (factory: (ui: unknown, theme: unknown, ...rest: unknown[]) => unknown): unknown =>
      factory(ui, undefined),
  };
  const host = {
    ui,
    build: (): unknown =>
      ui.custom(() => {
        rows.map((row) => row.category ?? "Settings");
        Object.freeze(rows);
        return { invalidate: () => {} };
      }),
  };
  registerRows({
    id: "loon.top",
    category: "Layout",
    placement: "start",
    rows: () => [{ label: "Top row", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  host.build();

  assert.deepEqual(labels(rows), [
    "Card bash: builtin",
    "Card output: builtin",
    "Banner: builtin",
    "Layout: builtin",
    "Top row",
  ]);
  const provider = collectStatus().providers[0];
  assert.equal(provider?.placement?.requested, "start");
  assert.equal(provider?.placement?.landed, "end");
  assert.match(provider?.placement?.reason ?? "", /frozen|read-only|would not accept|planned write/);
  assert.ok(
    formatStatus(collectStatus()).some((line) =>
      /^  - loon\.top \(Layout\), placement start → end \(.+\)$/u.test(line),
    ),
  );
});

test("a recorded landing keeps the resolver's exact fallback reason", () => {
  const rows = hostRows();
  const host = lateOnlyHost(rows);
  registerRows({
    id: "loon.lost",
    category: "Layout",
    placement: { after: "loon.nope" },
    rows: () => [{ label: "Lost row", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  host.build();

  const placement = collectStatus().providers[0]?.placement;
  assert.equal(placement?.requested, 'after "loon.nope"');
  assert.equal(placement?.landed, "end");
  assert.equal(
    placement?.reason,
    'after "loon.nope" is not a registered row provider id',
    "the verifier-pinned reason survives the landing report",
  );
});
