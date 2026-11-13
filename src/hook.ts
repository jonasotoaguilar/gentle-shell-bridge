/**
 * Hook backend (S4): prefer a real host registry over patching anything.
 *
 * ⚠️  UNVERIFIED BRANCH. No host has been observed exposing
 * `globalThis[Symbol.for("gentle-pi.customize-row-providers")]`; the key arrives from the
 * verified probe notes, but its value shape does not. The bridge therefore accepts exactly two
 * shapes and reports anything else:
 *
 * - a plain `Array` — the fan-out provider is appended with `push`;
 * - an object with a callable `register` method — the provider is handed to `register(provider)`.
 *
 * Anything else (primitive, function, `null`, object without a callable `register`) is
 * `unusable-hook`: the caller falls back to the capture backend and diagnostics records why. It is
 * never treated as "hooked", so a wrong guess degrades to the proven path instead of silently
 * doing nothing.
 *
 * Nothing here patches `ui.custom`. When the registry is usable the bridge installs no wrapper at
 * all, which is the whole point of preferring it.
 */

import type { CustomizeRow } from "./types.ts";
import { buildRows, contextFromHost, isRecord, type RowBuildFailure } from "./rows.ts";

/** The host registry key from S4. Read only; the bridge never creates it. */
const HOOK_REGISTRY = Symbol.for("gentle-pi.customize-row-providers");
/** Non-enumerable marker on the registry: this package already pushed its fan-out provider. */
const HOOK_ARMED = Symbol.for("gentle-shell-bridge.hook.armed.v1");
/** Process-global state for diagnostics, shared across package copies. */
const HOOK_STATE = Symbol.for("gentle-shell-bridge.hook.state.v1");

/** Stable id of the single provider the bridge pushes into a host registry. */
export const FAN_OUT_PROVIDER_ID = "gentle-shell-bridge";

/**
 * The provider pushed into the host registry. Its shape is a guess constrained by the unproven
 * registry: the fan-out already knows every row's category, so it carries no category of its own.
 */
export interface HookFanOutProvider {
  readonly id: string;
  rows(ctx?: unknown): CustomizeRow[];
}

export type HookShape = "array" | "register" | "unusable";

export type HookOutcome = "hooked" | "no-hook" | "unusable-hook";

export interface InstallHookResult {
  /** True when the registry now holds — or already held — the bridge's fan-out provider. */
  installed: boolean;
  outcome: HookOutcome;
  shape?: HookShape;
  /** Why a present registry was not usable. */
  reason?: string;
}

export interface HookDiagnostics {
  installed: boolean;
  shape?: HookShape;
  lastOutcome?: HookOutcome;
  /** Failures recorded during the most recent fan-out build. */
  lastFailures: RowBuildFailure[];
}

interface HookState {
  installed: boolean;
  shape?: HookShape;
  lastOutcome?: HookOutcome;
  lastFailures: RowBuildFailure[];
}

function hookHost(): Record<symbol, unknown> {
  // SAFETY: `globalThis` accepts symbol keys, and every value stored under HOOK_STATE is written
  // by `hookState()` below; a foreign value is rejected there before use.
  return globalThis as unknown as Record<symbol, unknown>;
}

function hookState(): HookState {
  const host = hookHost();
  const existing = host[HOOK_STATE];
  if (isHookState(existing)) return existing;
  const created: HookState = { installed: false, lastFailures: [] };
  host[HOOK_STATE] = created;
  return created;
}

function isHookState(value: unknown): value is HookState {
  return isRecord(value) && typeof value.installed === "boolean" && Array.isArray(value.lastFailures);
}

/** Diagnostics snapshot for `status` (S6) and for this backend's tests. */
export function getHookDiagnostics(): HookDiagnostics {
  const state = hookState();
  return {
    installed: state.installed,
    shape: state.shape,
    lastOutcome: state.lastOutcome,
    lastFailures: [...state.lastFailures],
  };
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. The registry marker stays. */
export function resetHookStateForTests(): void {
  const state = hookState();
  state.installed = false;
  state.shape = undefined;
  state.lastOutcome = undefined;
  state.lastFailures = [];
}

/**
 * Install the fan-out provider into the host registry, if the host exposes one. Idempotent: the
 * registry carries a non-enumerable marker, so a second arm — or a second copy of this package —
 * never pushes a second provider.
 */
export function installHookBackend(): InstallHookResult {
  const state = hookState();
  const registry = hookHost()[HOOK_REGISTRY];

  if (registry === undefined) {
    state.shape = undefined;
    state.lastOutcome = "no-hook";
    return { installed: false, outcome: "no-hook" };
  }

  const shape = classifyRegistry(registry);
  state.shape = shape;

  if (shape === "unusable") {
    state.installed = false;
    state.lastOutcome = "unusable-hook";
    return {
      installed: false,
      outcome: "unusable-hook",
      shape,
      reason: describeUnusable(registry),
    };
  }

  const target = registry as object;
  if (Object.hasOwn(target, HOOK_ARMED)) {
    state.installed = true;
    state.lastOutcome = "hooked";
    return { installed: true, outcome: "hooked", shape };
  }

  const provider = createFanOutProvider(state);
  if (shape === "array") {
    (registry as HookFanOutProvider[]).push(provider);
  } else {
    const register = (registry as { register: (provider: HookFanOutProvider) => unknown }).register;
    register.call(registry, provider);
  }

  try {
    Object.defineProperty(target, HOOK_ARMED, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // A frozen registry cannot be marked. The provider is already installed, so report success;
    // de-duplication is best-effort on a host object the bridge cannot write to.
  }

  state.installed = true;
  state.lastOutcome = "hooked";
  return { installed: true, outcome: "hooked", shape };
}

function classifyRegistry(value: unknown): HookShape {
  if (Array.isArray(value)) return "array";
  if (isRecord(value) && typeof value.register === "function") return "register";
  return "unusable";
}

function describeUnusable(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return `registry is a ${value === null ? "null" : typeof value}, not an array or a registry object`;
  }
  return "registry object has no callable register";
}

function createFanOutProvider(state: HookState): HookFanOutProvider {
  return {
    id: FAN_OUT_PROVIDER_ID,
    rows(hostCtx?: unknown): CustomizeRow[] {
      // Same ordered snapshot and same builder as the capture backend, so `registerRows`
      // behaves identically on either backend.
      const { rows, failures } = buildRows(contextFromHost(hostCtx));
      state.lastFailures = failures;
      return rows;
    },
  };
}
