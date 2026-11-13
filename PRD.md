# PRD — gentle-shell-bridge

## Problem

gentle-shell renders `/gentle:customize` from an array it builds itself and never exposes:
the `ctx.ui.custom` factory constructs a `VisualCustomizeView` and returns a six-method
adapter, so the rows exist only inside closures
(`extensions/gentle-shell.ts:3550`, `:3554-3561`). Any plugin that wants a settings line
therefore reaches for the only reachable moment — the factory call — and patches the host
to get at the rows.

That works once. It does not compose. Two independent wrappers each swap
`Array.prototype.map` around the same factory: the inner wrapper installs its patch last
and wins the capture, the outer wrapper captures nothing and degrades to a warning. With
the naive approach only one plugin's rows ever appear, and neither plugin can tell the
difference until someone looks at the menu. This is the collision the bridge exists to
remove, and it is observed behaviour, not a hypothesis: the first prototype using
duck-typing on the returned component silently injected nothing because the view is sealed
behind the adapter.

## Users

- **Plugin authors** (loon, and any future gentle-shell plugin) who want a settings row
  without owning an interception layer, a rebind lifecycle, or a conflict policy.
- **gentle-shell users** who want every installed plugin's settings in the one menu they
  already open, with no plugin silently missing.

## Goals

1. One interception layer per process, shared by every plugin.
2. A small, typed contract: publish a provider, get rows; dispose to remove them.
3. Rows that reflect live state, so the `●` marker never lies.
4. No silent failure: every absent row has a reportable reason.
5. One place to repair when gentle-shell's internals change.

## Non-goals

- Not a theme pack, banner engine or card renderer; it adds rows to existing categories.
- Not a UI framework: no widgets, layout engine, or rendering of its own.
- Not a configuration service for gentle-shell; gentle-shell keeps its own files.
- Not an upstream replacement: if Pi or gentle-shell ships a row-provider hook, the bridge
  should shrink to a thin adapter over it rather than compete.

## Requirements

| ID | Requirement | Contract | Status |
| --- | --- | --- | --- |
| R1 | `registerRows(provider)` accepts providers and returns a disposer that removes exactly that provider's rows. | `registerRows`, provider shape | Implemented; unit tests plus the end-to-end suite |
| R2 | Providers are evaluated lazily when the menu is built, in subscription order, with a context carrying at least the active theme and the resolved config home. | Provider `rows(ctx)`, ordering | Implemented; `ctx` carries the factory's theme and the resolved config home, tested |
| R3 | The bridge supports every row kind gentle-shell's renderer understands: `category`, `label`, `choice`, `preview`, `visible`, `keyhint`, `action`. | Row kinds | Implemented as typed pass-through fields; exercised against the fake host, not the real renderer |
| R4 | A toggle is expressed as consecutive rows sharing `choice.setting`, and works with the renderer's own `●`/`○` and arrow/Enter handling. | Toggle recipe | Implemented; the end-to-end suite shows the `●` moving after `action()` on a fake host |
| R5 | Arm-time state is idempotent: repeated `session_start`, rebinds and double loads never double-wrap or double-inject. | Idempotency | Implemented; tested across two `session_start` events and a double entry load |
| R6 | A throwing provider loses its rows, is reported, and never breaks the menu or other providers. | Failure isolation | Implemented; tested per provider, with the failure reported by `/bridge-status` |
| R7 | A diagnostics command reports providers, active backend, last capture outcome and last failures. | `/bridge-status` | Implemented as `/bridge-status`; formatter and entry tested, including store problems and duplicate settings |
| R8 | Composition is stateless; persistence is the plugin's, with an optional namespaced store helper. | `createStore`, [docs/state.md](docs/state.md) | Implemented; `createStore` tested against temporary directories |

All eight requirements are implemented and covered by the 96-test `node --test` suite. The
end-to-end tests drive a fake host that models `gentle-shell.ts:3550-3562`; none of them has
been re-run in the real TUI through the package, and R7's hook branch has never met a host
that exposes a registry. The capture technique itself is proven in the real TUI by the
reference probe, not by these tests.

## Success criteria

- Two independent providers coexist in one menu, each with its own rows and no lost
  capture.
- A toggle persists through `action()`, the menu re-renders, and the `●` moves to the
  applied value.
- No silent failure: an uncaptured menu, a broken provider or a duplicate `setting` is
  visible in `/bridge-status`.
- When gentle-shell changes its menu construction, exactly one module needs repair.
- The reference probe's observed result reproduces through the package against the fake host
  that models the real call chain: a `Cards` category showing the injected line
  `Card bash   ● activity ○ output`. It has not yet been re-run in the real TUI through the
  package.

## Risks and open questions

- **Upstream hook availability.** If Pi or gentle-shell adds a supported row-provider
  registry, the capture backend becomes dead weight; the contract should stay stable
  across that switch. A hook backend now exists (`src/hook.ts`) and prefers a recognized
  registry over patching, but no host has been observed emitting
  `Symbol.for("gentle-pi.customize-row-providers")` — that branch is implemented and
  unverified.
- **Namespace policy.** Requiring namespaced `setting` names (`"Loon → Banner source"`)
  avoids accidental merges but depends on authors complying; the bridge can warn on
  duplicates but cannot rename rows without breaking identity.
- **Whether the store belongs in the package at all.** It is the only piece that writes to
  disk and the only piece a plugin could implement itself. Shipping it is a convenience
  bet, recorded with its alternatives in [docs/state.md](docs/state.md).
- **Diagnostics spelling.** Settled in code: the command is `/bridge-status`. Pi has no
  built-in `/status`, and gentle-shell's commands live under the `gentle:` prefix, so a bare
  `bridge-status` collides with neither. It has not yet been typed into a real host.
- **Compatibility drift.** The capture depends on one constructor line and one adapter
  shape; every gentle-shell upgrade is a potential silent break until an upstream hook
  exists.
