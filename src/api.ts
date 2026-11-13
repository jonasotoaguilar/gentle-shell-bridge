/**
 * The runtime handshake: how a plugin reaches this bridge without a path, an environment variable
 * or an import.
 *
 * Pi gives two independent projects exactly one sanctioned channel that needs no install detail:
 * `globalThis` (`docs/extensions.md:1965-1972`). So the package publishes a frozen, versioned
 * service object at a stable symbol, and a plugin that loaded *before* the package leaves its
 * initialiser in a queue the package drains:
 *
 * ```ts
 * Symbol.for("gentle-shell-bridge/api/v1")      → { schema, version, VERSION, registerRows,
 *                                                   registerSection, createStore, drain }
 * Symbol.for("gentle-shell-bridge/pending/v1")  → Array<(api) => void>
 * ```
 *
 * Why a symbol instead of a path or `GENTLE_SHELL_BRIDGE_MODULE`: a path is not a contract between
 * two projects — it names one checkout on one machine, and it breaks the day either project moves.
 * The symbol key is the contract, and `v1` in the key is the major version: a future major takes a
 * NEW key rather than mutating this one. `pi-lens` publishes its IO bridge the same way
 * (`clients/io-bridge-contract.ts:26-31`, `clients/process-bridge.ts:31-66`): stable symbol, a
 * version constant, a frozen non-writable slot, and "version mismatch means unsupported".
 *
 * ## First wins, and nothing is ever reset
 *
 * Pi loads every extension through its own jiti loader with `moduleCache: false`, so this module
 * exists once per copy. Every copy's functions operate on the same process-global bus
 * (`./bus.ts`, `./store.ts`), which makes them interchangeable: whoever publishes first owns the
 * slot, and later copies hand the same object back. A slot that holds something incompatible is
 * treated as ABSENT — never overwritten, never deleted — and the bridge's own object is used for
 * draining, so a squatter cannot strand a queued plugin.
 *
 * ## Version skew
 *
 * Consumers gate on the schema string, `version === 1` and the three callable members
 * (`isBridgeApi`). A mismatch is not an error and never a fallback to a half-working object: the
 * caller registers through the queue instead, and one notice is recorded per process (the TUI
 * shows it once and `/bridge-status` keeps reporting it).
 *
 * ## Why `attachBridge` is also documented inline
 *
 * A plugin that does not depend on this package must be able to do the same thing in about six
 * lines, so README.md carries the inline copy of `attachBridge` and the two symbols. Keep the two
 * in sync.
 */

import { registerRows, registerSection } from "./bus.ts";
import { recordNotice } from "./notices.ts";
import { createStore } from "./store.ts";

/** The release that published the object; informational, never the compatibility check. */
export const VERSION = "0.1.0";

/** Identity of the object, so a foreign payload at the symbol is never mistaken for ours. */
export const API_SCHEMA = "gentle-shell-bridge/api";

/** Major version of the published shape. A breaking change means a new symbol key. */
export const API_VERSION = 1;

/** The published service object's stable, process-global key. */
export const BRIDGE_API_KEY: symbol = Symbol.for("gentle-shell-bridge/api/v1");

/** The early-loader queue: `init(api)` callbacks left by plugins that loaded first. */
export const BRIDGE_PENDING_KEY: symbol = Symbol.for("gentle-shell-bridge/pending/v1");

/** Bookkeeping for "one skew notice per process", kept off module scope for the same reason as the bus. */
const WARNED_KEY: symbol = Symbol.for("gentle-shell-bridge/api/v1.warned");

/**
 * The object published at `BRIDGE_API_KEY`.
 *
 * `drain` is part of the published shape but deliberately not part of the gate: it is the bridge's
 * own entry point into the queue, and a consumer never needs it to register anything.
 */
export interface BridgeApi {
  readonly schema: typeof API_SCHEMA;
  readonly version: typeof API_VERSION;
  /** The publishing release, e.g. `"0.1.0"`. Informational. */
  readonly VERSION: string;
  readonly registerRows: typeof registerRows;
  readonly registerSection: typeof registerSection;
  readonly createStore: typeof createStore;
  readonly drain?: () => void;
}

/** What a plugin leaves behind when the bridge is not loaded yet. */
export type BridgeInit = (api: BridgeApi) => void;

function apiHost(): Record<symbol, unknown> {
  // SAFETY: `globalThis` accepts symbol keys, and every write to these slots happens in this module
  // behind the shape checks below.
  return globalThis as unknown as Record<symbol, unknown>;
}

/**
 * The early-loader queue, created on first use.
 *
 * A pre-existing value that is not an array is replaced: unlike the API slot, this one holds no
 * contract, only a list of callbacks, so a foreign value means "nothing to drain" rather than a
 * version dispute.
 */
function pendingQueue(): BridgeInit[] {
  const host = apiHost();
  const existing = host[BRIDGE_PENDING_KEY];
  if (Array.isArray(existing)) return existing as BridgeInit[];
  const created: BridgeInit[] = [];
  host[BRIDGE_PENDING_KEY] = created;
  return created;
}

interface WarnedState {
  skew: boolean;
}

function warnedState(): WarnedState {
  const host = apiHost();
  const existing = host[WARNED_KEY];
  if (typeof existing === "object" && existing !== null) {
    const candidate = existing as Partial<WarnedState>;
    if (typeof candidate.skew === "boolean") return candidate as WarnedState;
  }
  const created: WarnedState = { skew: false };
  host[WARNED_KEY] = created;
  return created;
}

/** One clear notice per process, no matter how many copies ask. */
function warnSkewOnce(): void {
  const state = warnedState();
  if (state.skew) return;
  state.skew = true;
  recordNotice(
    `gentle-shell-bridge: the slot ${String(BRIDGE_API_KEY)} holds an object that is not the ` +
      `"${API_SCHEMA}" API version ${String(API_VERSION)} this process expects (a different major ` +
      "version, another library's payload, or a partial object). It is treated as ABSENT: plugins " +
      "register through the early-loader queue instead, and the slot is left in place — it is " +
      "never overwritten and never reset. This notice is recorded once per process and appears " +
      "in the TUI and in /bridge-status.",
    "warning",
  );
}

/**
 * The shape gate: the schema string, `version === 1`, and the three members a consumer calls.
 * Anything else — another library's object, a future major version, a partial object — is absent,
 * never an error.
 */
export function isBridgeApi(value: unknown): value is BridgeApi {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schema === API_SCHEMA &&
    candidate.version === API_VERSION &&
    typeof candidate.registerRows === "function" &&
    typeof candidate.registerSection === "function" &&
    typeof candidate.createStore === "function"
  );
}

/** The object this copy publishes when it owns the slot (or when the slot is unusable). */
const LOCAL_API: BridgeApi = Object.freeze({
  schema: API_SCHEMA,
  version: API_VERSION,
  VERSION,
  registerRows,
  registerSection,
  createStore,
  drain: drainBridgeQueue,
});

/** The slot's object when it passes the gate; `undefined` when it is absent or incompatible. */
function compatibleApi(): BridgeApi | undefined {
  const existing = apiHost()[BRIDGE_API_KEY];
  if (existing === undefined) return undefined;
  if (isBridgeApi(existing)) return existing;
  warnSkewOnce();
  return undefined;
}

/**
 * Publish this copy's API object, then drain the queue.
 *
 * Runs at module load, so loading the package — through `./extension.ts` or `./index.ts` — makes
 * the API available before any `session_start`. First wins: a valid object already in the slot is
 * kept and returned untouched. An incompatible object is kept too (never reset); draining then
 * runs on this copy's own object, which operates on the same process-global bus.
 */
export function publishBridgeApi(): BridgeApi {
  const host = apiHost();
  const existing = host[BRIDGE_API_KEY];
  let api: BridgeApi;
  if (existing === undefined) {
    host[BRIDGE_API_KEY] = LOCAL_API;
    api = LOCAL_API;
  } else if (isBridgeApi(existing)) {
    api = existing;
  } else {
    warnSkewOnce();
    api = LOCAL_API;
  }
  drainBridgeQueue();
  return api;
}

/**
 * Run every queued initialiser once, then empty the queue.
 *
 * Cheap enough to call on every `session_start` (an empty array returns immediately) and idempotent
 * by construction: a plugin registers by stable id, so a repeated drain — or the same plugin queued
 * twice by two loads — replaces instead of stacking. A throwing initialiser is isolated: it is
 * recorded on the in-TUI notice channel and the remaining ones still run, so a broken third-party
 * plugin can never take the session handler down.
 */
export function drainBridgeQueue(): void {
  const queue = pendingQueue();
  if (queue.length === 0) return;
  // Take the list before running anything: an initialiser that publishes or attaches must not see
  // (or mutate) the array being iterated.
  const pending = queue.splice(0, queue.length);
  const api = compatibleApi() ?? LOCAL_API;
  for (const init of pending) {
    if (typeof init !== "function") continue;
    try {
      init(api);
    } catch (error) {
      recordNotice(
        "gentle-shell-bridge: a queued plugin initialiser threw and was skipped; the rest of the " +
          `queue and the bridge itself keep going: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  }
}

/**
 * Call `init` now when a compatible API is published, otherwise queue it for the bridge.
 *
 * This is the whole handshake, and README.md documents the same six lines inline for a plugin that
 * does not depend on this package. A plugin may call it more than once (a double load); each init
 * registers by stable id, so the result is a replacement, not a duplicate.
 */
export function attachBridge(init: BridgeInit): void {
  if (typeof init !== "function") {
    throw new TypeError("gentle-shell-bridge: attachBridge(init) requires an init function");
  }
  const api = compatibleApi();
  if (api !== undefined) {
    init(api);
    return;
  }
  pendingQueue().push(init);
}

/**
 * Test-only seam: forget the published object, the queue and the once-per-process notice flag. Clearing
 * the published object is what lets a test model "the plugin loaded first"; the extension never
 * calls this. Deliberately not re-exported from `src/index.ts`.
 */
export function resetBridgeApiForTests(): void {
  const host = apiHost();
  delete host[BRIDGE_API_KEY];
  delete host[BRIDGE_PENDING_KEY];
  delete host[WARNED_KEY];
}

// The publishing point: loading this module publishes the API and drains anything that loaded
// earlier. `./extension.ts` imports it, so Pi's load order can never hide the handshake.
publishBridgeApi();
