/**
 * The worked example's runtime handshake (S1, S5 "zero extra steps").
 *
 * `examples/bash-card.ts` is what a plugin author copies. It must reach the bridge with no path,
 * no environment variable and no import of the package — only the stable symbol — and it must
 * register from its own `session_start` handler, where the symbol's presence is the complete
 * answer. These tests drive the real file, in a fresh module instance per scenario, against the
 * published contract.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BRIDGE_API_KEY,
  publishBridgeApi,
  resetBridgeApiForTests,
} from "../src/api.ts";
import { resetBusForTests, resetSectionsForTests, snapshotProviders, snapshotSections, snapshotTransforms } from "../src/bus.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { CustomizeRow, InlineHelpers } from "../src/types.ts";

const hostSlot = (): Record<symbol, unknown> => globalThis as unknown as Record<symbol, unknown>;

type SessionHandler = (event: unknown, ctx: { hasUI?: boolean; ui?: unknown }) => void;

interface FakePi {
  registerToolRenderer?: (resolver: unknown) => void;
  on?: (event: string, handler: SessionHandler) => void;
}

type ExampleInit = (pi: FakePi) => () => void;

/**
 * One fresh module instance per scenario: the example keeps nothing on `globalThis`, so a query
 * string is enough to model "this file was loaded again".
 */
const loadExample = async (tag: string): Promise<ExampleInit> => {
  const specifier = new URL(`../examples/bash-card.ts?${tag}`, import.meta.url).href;
  const loaded = (await import(specifier)) as { default: ExampleInit };
  return loaded.default;
};

const recordingPi = (): {
  pi: FakePi;
  registrations: () => number;
  sessionHandlers: SessionHandler[];
} => {
  const state = { registrations: 0 };
  const sessionHandlers: SessionHandler[] = [];
  const pi: FakePi = {
    registerToolRenderer: () => {
      state.registrations += 1;
    },
    on(event, handler) {
      assert.equal(event, "session_start");
      sessionHandlers.push(handler);
    },
  };
  return { pi, registrations: () => state.registrations, sessionHandlers };
};

/** Every terminal write the process would show: the example must produce none. */
const captureConsole = (): { writes: string[]; restore: () => void } => {
  const writes: string[] = [];
  const sink = (globalThis as unknown as { console: { log: unknown; warn: unknown; error: unknown } })
    .console;
  const original = { log: sink.log, warn: sink.warn, error: sink.error };
  const record =
    (method: string) =>
    (...args: unknown[]): void => {
      writes.push(`${method}: ${args.map((arg) => String(arg)).join(" ")}`);
    };
  sink.log = record("log");
  sink.warn = record("warn");
  sink.error = record("error");
  return {
    writes,
    restore: () => {
      sink.log = original.log;
      sink.warn = original.warn;
      sink.error = original.error;
    },
  };
};

interface NotifySurface {
  notify: (message: string, level?: "info" | "warning" | "error") => void;
}

const notifySurface = (): {
  ui: NotifySurface;
  calls: Array<[string, string | undefined]>;
} => {
  const calls: Array<[string, string | undefined]> = [];
  return { ui: { notify: (message, level) => calls.push([message, level]) }, calls };
};

const inlineHelpers: InlineHelpers = {
  input: async () => undefined,
  confirm: async () => true,
  capture: async () => undefined,
};

let configHome: string;
let previousConfigHome: string | undefined;
let previousModuleEnv: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-example-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  previousModuleEnv = process.env.GENTLE_SHELL_BRIDGE_MODULE;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
  // The rejected design's override must not be needed for anything below; make sure it cannot
  // silently supply the bridge in these tests.
  delete process.env.GENTLE_SHELL_BRIDGE_MODULE;
});

test.after(() => {
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  if (previousModuleEnv === undefined) delete process.env.GENTLE_SHELL_BRIDGE_MODULE;
  else process.env.GENTLE_SHELL_BRIDGE_MODULE = previousModuleEnv;
  rmSync(configHome, { recursive: true, force: true });
});

test.beforeEach(() => {
  rmSync(join(configHome, "gentle-shell-bridge"), { recursive: true, force: true });
  resetBridgeApiForTests();
  resetBusForTests();
  resetSectionsForTests();
  resetStoreStateForTests();
});

const sectionContext = (): { theme: unknown; configHome: string } => ({
  theme: undefined,
  configHome,
});

const rowContext = sectionContext;

const providerById = (id: string): ReturnType<typeof snapshotProviders>[number] | undefined =>
  snapshotProviders().find((registered) => registered.id === id);

test("with no bridge installed the example adds nothing and says so once", async () => {
  const captured = captureConsole();
  const { pi, registrations, sessionHandlers } = recordingPi();
  try {
    const init = await loadExample("no-bridge");
    assert.doesNotThrow(() => init(pi));
  } finally {
    captured.restore();
  }

  assert.deepEqual(captured.writes, [], "nothing lands in the terminal");
  assert.equal(sessionHandlers.length, 1, "a session_start handler carries the answer");
  assert.equal(
    registrations(),
    0,
    "the example claims no tool renderer: the bridge transform is the single owner",
  );

  const { ui, calls } = notifySurface();
  sessionHandlers[0]({}, { hasUI: true, ui });
  sessionHandlers[0]({}, { hasUI: true, ui });
  assert.equal(calls.length, 1, "one notice, delivered exactly once");
  assert.equal(calls[0][1], "warning", "Pi renders it as a warning, in its own report");
  assert.match(calls[0][0], /no compatible gentle-shell-bridge is installed/u);
  assert.match(calls[0][0], /adds nothing/u);
  assert.deepEqual(snapshotProviders(), []);
  assert.deepEqual(snapshotSections(), []);
});

test("the absent notice waits for a UI and is delivered exactly once", async () => {
  const { pi, sessionHandlers } = recordingPi();
  const init = await loadExample("absent-waits-for-ui");
  init(pi);

  const { ui, calls } = notifySurface();
  sessionHandlers[0]({}, { hasUI: false, ui });
  sessionHandlers[0]({}, {});
  assert.deepEqual(calls, [], "a session without a UI shows nothing");

  sessionHandlers[0]({}, { hasUI: true, ui });
  sessionHandlers[0]({}, { hasUI: true, ui });
  assert.equal(calls.length, 1, "the buffered message waits for a UI that can show it");
  assert.match(calls[0][0], /no compatible gentle-shell-bridge is installed/u);
  assert.deepEqual(snapshotProviders(), []);
  assert.deepEqual(snapshotSections(), []);
});

test("an old or foreign bridge is treated as absent, and only through notify", async () => {
  hostSlot()[BRIDGE_API_KEY] = { schema: "gentle-shell-bridge/api", version: 0 };
  const captured = captureConsole();
  const { pi, sessionHandlers } = recordingPi();
  try {
    const init = await loadExample("old-bridge");
    init(pi);
  } finally {
    captured.restore();
  }

  assert.deepEqual(captured.writes, [], "nothing lands in the terminal");

  const { ui, calls } = notifySurface();
  sessionHandlers[0]({}, { hasUI: true, ui });
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /no compatible gentle-shell-bridge is installed/u);
  assert.deepEqual(snapshotSections(), []);
  assert.equal(
    hostSlot()[BRIDGE_API_KEY] !== undefined,
    true,
    "the example never removes the slot it cannot use",
  );
});

test("the example's session handler does nothing without a UI, then registers on the next one", async () => {
  publishBridgeApi();
  const { pi, sessionHandlers } = recordingPi();
  const init = await loadExample("no-ui");
  init(pi);

  const { ui, calls } = notifySurface();
  sessionHandlers[0]({}, { hasUI: false, ui });
  sessionHandlers[0]({}, {});
  assert.deepEqual(calls, [], "a session without a UI shows nothing");
  assert.deepEqual(snapshotProviders(), [], "and registers nothing before a UI can show it");

  sessionHandlers[0]({}, { hasUI: true, ui });
  assert.ok(providerById("bash-card-example.rendering") !== undefined);
  assert.ok(snapshotSections().some((registered) => registered.id === "bash-card.status"));
});

test("a Pi without registerToolRenderer is enough: the example claims no renderer slot", async () => {
  publishBridgeApi();
  const sessionHandlers: SessionHandler[] = [];
  const pi: FakePi = {
    on(_event, handler) {
      sessionHandlers.push(handler);
    },
  };
  const captured = captureConsole();
  try {
    const init = await loadExample("no-renderer");
    init(pi);
  } finally {
    captured.restore();
  }

  assert.deepEqual(captured.writes, []);
  const { ui, calls } = notifySurface();
  sessionHandlers[0]({}, { hasUI: true, ui });
  assert.deepEqual(calls, [], "no notice: the example needs no renderer slot to render bash");
  assert.ok(
    providerById("bash-card-example.rendering") !== undefined,
    "the bridge surfaces register on any Pi",
  );
  assert.deepEqual(
    snapshotTransforms().map((transform) => transform.id),
    ["bash-card-example.bash-cards"],
    "and the toggle's rendering is a transform, not a resolver",
  );
});

test("with the API present at session_start the example registers rows, store and section", async () => {
  publishBridgeApi();
  const captured = captureConsole();
  const { pi, sessionHandlers } = recordingPi();
  try {
    const init = await loadExample("present");
    init(pi);
  } finally {
    captured.restore();
  }

  assert.deepEqual(captured.writes, [], "no waiting message: the bridge was already there");
  assert.deepEqual(snapshotProviders(), [], "nothing registers at module load");
  assert.deepEqual(snapshotSections(), []);

  const { ui, calls } = notifySurface();
  sessionHandlers[0]({}, { hasUI: true, ui });
  assert.deepEqual(calls, [], "and no notice to deliver");

  const provider = providerById("bash-card-example.rendering");
  assert.ok(provider !== undefined, "the example's rows provider registered itself");

  const rows: CustomizeRow[] = provider.rows(rowContext());
  assert.deepEqual(
    rows.map((row) => row.choice?.value),
    ["default", "tool"],
    "the two consecutive toggle values are the plugin's own",
  );
  const toolRow = rows.find((row) => row.choice?.value === "tool");
  assert.ok(toolRow?.action !== undefined);
  toolRow.action(inlineHelpers);

  // The store really is the bridge's, and it wrote where `createStore` puts it.
  assert.deepEqual(
    JSON.parse(readFileSync(join(configHome, "gentle-shell-bridge", "bash-card-example.json"), "utf8")),
    { schemaVersion: 1, values: { bashRendering: "tool" } },
  );

  const exampleSection = snapshotSections().find((registered) => registered.id === "bash-card.status");
  assert.ok(exampleSection !== undefined, "the example's section registered itself");
  assert.equal(exampleSection.meta?.(sectionContext()), "tool", "and reads the value just written");
  const lines = exampleSection.lines(sectionContext());
  assert.deepEqual(lines, ["rendering  tool", "transform  registered"]);
});

test("two session_start events leave one provider and one section, not two", async () => {
  publishBridgeApi();
  const { pi, sessionHandlers } = recordingPi();
  const init = await loadExample("twice");
  init(pi);
  const { ui } = notifySurface();

  sessionHandlers[0]({}, { hasUI: true, ui });
  sessionHandlers[0]({}, { hasUI: true, ui });

  assert.deepEqual(
    snapshotProviders().map((registered) => registered.id),
    ["bash-card-example.rendering"],
  );
  assert.deepEqual(
    snapshotSections().map((registered) => registered.id),
    ["bash-card.status"],
  );
});

test("the disposer the example returns removes both its registrations", async () => {
  publishBridgeApi();
  const captured = captureConsole();
  const { pi, sessionHandlers } = recordingPi();
  let dispose = (): void => {};
  try {
    const init = await loadExample("dispose");
    dispose = init(pi);
  } finally {
    captured.restore();
  }
  assert.deepEqual(captured.writes, []);

  const { ui } = notifySurface();
  sessionHandlers[0]({}, { hasUI: true, ui });

  assert.ok(providerById("bash-card-example.rendering") !== undefined);
  assert.ok(snapshotSections().some((registered) => registered.id === "bash-card.status"));

  dispose();

  assert.equal(providerById("bash-card-example.rendering"), undefined);
  assert.equal(snapshotSections().some((registered) => registered.id === "bash-card.status"), false);
});

test("the example's runtime path resolves no module of the bridge", () => {
  const source = readFileSync(
    new URL("../examples/bash-card.ts", import.meta.url),
    "utf8",
  );

  assert.equal(
    /GENTLE_SHELL_BRIDGE_MODULE/u.test(source),
    false,
    "the environment-variable override is gone",
  );
  assert.equal(/bridgeCandidates/u.test(source), false, "the path probing is gone");
  assert.equal(/await\s+import\s*\(/u.test(source), false, "nothing is imported at runtime");
  assert.equal(
    /from\s+["']gentle-shell-bridge["']/u.test(source),
    false,
    "the package is never imported, not even for types",
  );
  assert.match(source, /Symbol\.for\("gentle-shell-bridge\/api\/v1"\)/u);
  assert.equal(
    /gentle-shell-bridge\/pending\/v1/u.test(source),
    false,
    "the early-loader queue is gone from the example too",
  );
  assert.equal(/console\./u.test(source), false, "no console write survives in the example");
  assert.match(source, /pi\.on\("session_start"/u, "registration happens in session_start");
});

test("the absent case writes zero bytes to stdout and stderr", () => {
  const specifier = new URL("../examples/bash-card.ts?zero-bytes", import.meta.url).href;
  const script = `
    import example from ${JSON.stringify(specifier)};
    const handlers = [];
    const pi = {
      registerToolRenderer() {},
      on(event, handler) { handlers.push(handler); },
    };
    example(pi);
    for (const handler of handlers) handler({}, { hasUI: true, ui: { notify() {} } });
  `;
  const captured = captureConsole();
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, GENTLE_PI_CONFIG_HOME: configHome },
    });
  } finally {
    captured.restore();
  }

  assert.equal(result.status, 0, `the example ran (stderr: ${String(result.stderr)})`);
  assert.equal(result.stdout, "", "no stdout bytes");
  assert.equal(result.stderr, "", "no stderr bytes");
});
