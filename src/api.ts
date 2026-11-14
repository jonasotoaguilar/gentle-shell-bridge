/**
 * The runtime handshake: how a plugin reaches this bridge without a path, an environment variable
 * or an import.
 *
 * Pi gives two independent projects exactly one sanctioned channel that needs no install detail:
 * `globalThis` (`docs/extensions.md:1965-1972`). So the package publishes a frozen, versioned
 * service object at a stable symbol, at module load:
 *
 * ```ts
 * Symbol.for("gentle-shell-bridge/api/v1") → { schema, version, VERSION, registerRows,
 *                                              registerSection, createStore }
 * ```
 *
 * A plugin registers from its own `session_start` handler. Pi finishes loading every extension
 * module before it fires `session_start` (`docs/extensions.md:213`, `:393`, `:512`), and this
 * module publishes as it loads, so by the time any plugin's handler runs the API either exists or
 * the bridge is not installed. That makes the symbol's presence the complete answer: there is no
 * queue, no deferral and nothing to wait for. `bridgeApi()` returns the object, or `undefined`.
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
 * treated as ABSENT — never overwritten, never deleted.
 *
 * ## Version skew
 *
 * Consumers gate on the schema string, `version === 1` and the three callable members
 * (`isBridgeApi`). A mismatch is not an error and never a fallback to a half-working object: the
 * caller sees `undefined`, and one notice is recorded per process (the TUI shows it once and
 * `/bridge-status` keeps reporting it).
 *
 * ## Why the gate is also documented inline
 *
 * A plugin that does not depend on this package must be able to do the same thing in about six
 * lines, so README.md carries the inline copy of the gate and the symbol. Keep the two in sync.
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

/** Bookkeeping for "one skew notice per process", kept off module scope for the same reason as the bus. */
const WARNED_KEY: symbol = Symbol.for("gentle-shell-bridge/api/v1.warned");

/** The object published at `BRIDGE_API_KEY`. */
export interface BridgeApi {
  readonly schema: typeof API_SCHEMA;
  readonly version: typeof API_VERSION;
  /** The publishing release, e.g. `"0.1.0"`. Informational. */
  readonly VERSION: string;
  readonly registerRows: typeof registerRows;
  readonly registerSection: typeof registerSection;
  readonly createStore: typeof createStore;
}

function apiHost(): Record<symbol, unknown> {
  // SAFETY: `globalThis` accepts symbol keys, and every write to these slots happens in this module
  // behind the shape checks below.
  return globalThis as unknown as Record<symbol, unknown>;
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
    `gentle-shell-bridge: the slot ${String(BRIDGE_API_KEY)} holds something that is not the ` +
      `"${API_SCHEMA}" API version ${String(API_VERSION)} this process expects (a different major ` +
      "version, another library's payload, or a partial object). It is treated as ABSENT: " +
      "bridgeApi() returns undefined and plugins register nothing through this slot. The slot is " +
      "left exactly as it is — it is never overwritten and never reset. This notice is recorded " +
      "once per process and appears in the TUI and in /bridge-status.",
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
 * The validated published object, or `undefined`.
 *
 * This is the whole handshake for a plugin that imports the package. Call it from a
 * `session_start` handler: `undefined` means the bridge is not installed (or publishes a version
 * without this surface), and there is nothing to wait for.
 */
export function bridgeApi(): BridgeApi | undefined {
  return compatibleApi();
}

/**
 * Publish this copy's API object.
 *
 * Runs at module load, so loading the package — through `./extension.ts` or `./index.ts` — makes
 * the API available before any `session_start`. First wins: a valid object already in the slot is
 * kept and returned untouched. An incompatible object is kept too (never reset), and this copy's
 * own object is returned so its own extension can still register through the same bus.
 */
export function publishBridgeApi(): BridgeApi {
  const host = apiHost();
  const existing = host[BRIDGE_API_KEY];
  if (existing === undefined) {
    host[BRIDGE_API_KEY] = LOCAL_API;
    return LOCAL_API;
  }
  if (isBridgeApi(existing)) return existing;
  warnSkewOnce();
  return LOCAL_API;
}

/**
 * Test-only seam: forget the published object and the once-per-process notice flag. Clearing the
 * published object is what lets a test model "the bridge is not installed"; the extension never
 * calls this. Deliberately not re-exported from `src/index.ts`.
 */
export function resetBridgeApiForTests(): void {
  const host = apiHost();
  delete host[BRIDGE_API_KEY];
  delete host[WARNED_KEY];
}

// The publishing point: loading this module publishes the API. `./extension.ts` imports it, so
// Pi's load order can never hide the handshake.
publishBridgeApi();
