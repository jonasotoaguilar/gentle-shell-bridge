/**
 * The plugin surface: what a plugin contributes to gentle-shell's Keymaps page and to its command
 * palette, published at a symbol for the host to read while it builds either menu.
 *
 * Direction is deliberate. `./api.ts` publishes what plugins CALL; this module publishes what they
 * CONTRIBUTED, for the shell to consume. The host reads it lazily, per menu and palette build, so a
 * registration made during `session_start` shows up at the next open — no startup cache, no
 * lifecycle in the host, no load-order race between two extensions.
 *
 * ```ts
 * Symbol.for("gentle-shell-bridge/plugin-surface/v1") → { schema: 1, keymaps(), commands() }
 * ```
 *
 * The two channels answer with a copy, never the live array, so a host that keeps one cannot mutate
 * what the bridge owns. Entries are validated here, where the plugin author can see the error, and
 * the host validates again on read: a process may hold a copy of this module from before a field
 * existed, and the host must survive that anyway.
 *
 * Nothing here binds a key. Pi reads extension shortcuts at startup and on `/reload`, so the plugin
 * (or its caller) registers the shortcut itself; `resolveKeymap` answers which key to use by asking
 * the shell, so the answer comes from ONE implementation of environment-then-saved-then-default
 * instead of a second copy that would drift.
 */

import { recordNotice } from "./notices.ts";

/** The stable, process-global key the host reads; `v1` is the major version. */
export const PLUGIN_SURFACE_KEY: symbol = Symbol.for("gentle-shell-bridge/plugin-surface/v1");

/** The shell's own half of the keymap handshake: it publishes the effective key of any id. */
export const KEYMAP_RESOLVER_KEY: symbol = Symbol.for("gentle-pi/keymaps/v1");

/** One action a plugin wants listed on the Keymaps page, editable there like a native one. */
export interface KeymapRegistration {
  /** Plugin-owned and stable. Never a `command:<name>` id: those belong to the palette. */
  readonly id: string;
  readonly label: string;
  /** The environment variable that overrides the key, same semantics as a native action. */
  readonly env?: string;
  readonly defaultKey?: string;
  /** The slash command this action invokes, when it has one. */
  readonly command?: string;
}

/** One item a plugin wants in the command palette. */
export interface CommandContribution {
  /** Stable, unique among contributions. */
  readonly id: string;
  readonly label: string;
  /** The slash command the palette runs. Listed only while that command is registered. */
  readonly command: string;
  /** An existing palette section, or a new one this plugin opens. Omitted means the shared page. */
  readonly section?: string;
}

/** What `resolveKeymap` can answer: the key, or why the shell cannot tell. */
export interface KeymapResolution {
  readonly key?: string;
  readonly unavailable?: string;
}

interface SurfaceState {
  readonly keymaps: KeymapRegistration[];
  readonly commands: CommandContribution[];
}

/**
 * The state lives on a symbol, not in a module local: Pi loads every extension copy with
 * `moduleCache: false`, so two copies of this module must share one registry exactly like the bus
 * does. First copy creates it, later copies find it.
 */
const STATE_KEY: symbol = Symbol.for("gentle-shell-bridge/plugin-surface/v1.state");

function state(): SurfaceState {
  const slot = globalThis as Record<symbol, unknown>;
  const existing = slot[STATE_KEY] as SurfaceState | undefined;
  if (existing !== undefined) return existing;
  const created: SurfaceState = { keymaps: [], commands: [] };
  slot[STATE_KEY] = created;
  return created;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function requireText(field: string, value: unknown): string {
  const resolved = text(value);
  if (resolved === undefined) throw new TypeError(`gentle-shell-bridge: ${field} must be a non-empty string.`);
  return resolved;
}

function optionalText(field: string, value: unknown): string | undefined {
  return value === undefined ? undefined : requireText(field, value);
}

/** A frozen entry with the fields that are actually set: no `undefined` keys cross the symbol. */
function compact<T extends object>(value: Record<string, unknown>): T {
  const entry: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (item !== undefined) entry[key] = item;
  return Object.freeze(entry) as T;
}

/** Publish the surface once per process; later copies hand the same object back, never replace it. */
function publishSurface(): void {
  const slot = globalThis as Record<symbol, unknown>;
  if (slot[PLUGIN_SURFACE_KEY] !== undefined) return;
  slot[PLUGIN_SURFACE_KEY] = Object.freeze({
    schema: 1,
    keymaps: () => state().keymaps.slice(),
    commands: () => state().commands.slice(),
  });
}

/**
 * Register one keymapped action for the Keymaps page. Returns the disposer that removes exactly
 * this registration: a replaced registration is a different entry, so disposing the old one never
 * deletes its successor.
 *
 * A duplicate `id` replaces in place and is reported, like every other registration in this
 * package: a silent takeover would be a plugin stealing another plugin's row.
 */
export function registerKeymap(registration: KeymapRegistration): () => void {
  const id = requireText("id", registration?.id);
  if (id.startsWith("command:")) {
    throw new TypeError(
      `gentle-shell-bridge: keymap id "${id}" is reserved; "command:" names a palette command binding. Register a command with registerCommands instead.`,
    );
  }
  const entry: KeymapRegistration = compact<KeymapRegistration>({
    id,
    label: requireText("label", registration.label),
    env: optionalText("env", registration.env),
    defaultKey: optionalText("defaultKey", registration.defaultKey),
    command: optionalText("command", registration.command),
  });
  const list = state().keymaps;
  const at = list.findIndex((candidate) => candidate.id === id);
  if (at >= 0) {
    list[at] = entry;
    recordNotice(`[bridge] keymap "${id}" was registered twice; the newest registration wins.`);
  } else {
    list.push(entry);
  }
  return () => {
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
  };
}

/** Register one palette item, or several. Returns the disposer that removes exactly those items. */
export function registerCommands(contribution: CommandContribution | readonly CommandContribution[]): () => void {
  const entries = (Array.isArray(contribution) ? contribution : [contribution]) as readonly CommandContribution[];
  if (entries.length === 0) throw new TypeError("gentle-shell-bridge: registerCommands needs at least one contribution.");
  const seen = new Set<string>();
  const created = entries.map((candidate) => {
    const id = requireText("id", candidate?.id);
    // Twice in ONE call is an author error: the batch would silently keep only the last one.
    if (seen.has(id)) throw new TypeError(`gentle-shell-bridge: palette item "${id}" appears twice in one registration.`);
    seen.add(id);
    return compact<CommandContribution>({
      id,
      label: requireText("label", candidate.label),
      command: requireText("command", candidate.command),
      section: optionalText("section", candidate.section),
    });
  });
  // Twice in this process is a reload or a second `session_start`, not a takeover: replace in place
  // and say so, exactly like every other registration in this package.
  const list = state().commands;
  for (const entry of created) {
    const at = list.findIndex((existing) => existing.id === entry.id);
    if (at >= 0) {
      list[at] = entry;
      recordNotice(`[bridge] palette item "${entry.id}" was registered twice; the newest registration wins.`);
    } else {
      list.push(entry);
    }
  }
  return () => {
    for (const entry of created) {
      const index = list.indexOf(entry);
      if (index >= 0) list.splice(index, 1);
    }
  };
}

/**
 * The key `id` currently uses, answered by the shell that owns the file, the environment override
 * and the defaults. Never throws: no shell, an older shell or a throwing getter is an
 * `unavailable` reason the caller can report, not a crash inside a plugin's `session_start`.
 */
export function resolveKeymap(id: string): KeymapResolution {
  const key = requireText("id", id);
  let resolver: unknown;
  try {
    resolver = (globalThis as Record<symbol, unknown>)[KEYMAP_RESOLVER_KEY];
  } catch {
    resolver = undefined;
  }
  const candidate = typeof resolver === "object" && resolver !== null ? resolver as Record<string, unknown> : undefined;
  if (candidate?.schema !== 1 || typeof candidate.effectiveKey !== "function") {
    return {
      unavailable:
        "the installed gentle-shell does not publish its keymap resolver (gentle-pi/keymaps/v1); update gentle-shell to bind a plugin key, or read keymaps.json yourself.",
    };
  }
  try {
    const resolved = (candidate.effectiveKey as (actionId: string) => unknown)(key);
    return typeof resolved === "string" && resolved !== "" ? { key: resolved } : {};
  } catch (error) {
    return { unavailable: `gentle-shell's keymap resolver failed for "${key}": ${error instanceof Error ? error.message : String(error)}` };
  }
}

publishSurface();
