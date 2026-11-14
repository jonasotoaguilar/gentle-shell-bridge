# Architecture — how the bridge reaches gentle-shell's menu

Every claim in this document is either read from the cited source or observed in the real
TUI. Paths without a repository prefix are Pi (`packages/coding-agent/src/...`) or
gentle-shell (`extensions/...`, `lib/...`) files. Anything not proven is in **Limits** at
the end.

The contract itself lives in [contract.md](contract.md); the persistence decision in
[state.md](state.md).

## 1. Shape

```
plugin A ─┐
plugin B ─┼─ registerRows(provider) ─→ globalThis[Symbol.for(...)] ─→ bridge
plugin C ─┘                                                              │
                                                    one ctx.ui.custom wrapper
                                                                         │
                                               capture during the factory call
                                                                         │
                                              fan-out: A + B + C rows, in order
                                                                         │
                                                 gentle-shell VisualCustomizeView
```

N plugins × M gentle-shell surfaces → N providers, one interception. The bridge is a typed
facade over a process-global bus, never a module-level singleton (see §5).

## 2. One `ctx.ui` per runner, rebuilt on every bind

All extension contexts share a single UI object per runner, so a patch installed from one
extension is visible to every extension:

```ts
get ui() {
    runner.assertActive();
    return runner.uiContext;
}
```

`packages/coding-agent/src/core/extensions/runner.ts:896-898`.

That object is not stable. `setUIContext()` reassigns it
(`runner.ts:572-575`: `this.uiContext = uiContext ? this.wrapUIPromptContext(uiContext) : noOpUIContext`),
and `wrapUIPromptContext` returns a **new object literal** each time, with `custom` as an
own property wrapping `withUIPrompt` (`runner.ts:577-587`). Consequence: a patch does not
survive a rebind. The bridge therefore arms inside its `session_start` handler, and arming
must be idempotent — a non-enumerable marker installed with `Object.defineProperty` on the
target object, so a second `session_start`, a `/reload` or a double load never double-wraps.

## 3. The `custom()` call chain

`custom` on the facade maps straight through to the interactive mode
(`packages/coding-agent/src/modes/interactive/interactive-mode.ts:2794`:
`custom: (factory, options) => this.showExtensionCustom(factory, options)`).

`showExtensionCustom` resolves the component with

```ts
Promise.resolve(factory(this.ui, theme, this.keybindings, close))
```

around `interactive-mode.ts:3136`, and forwards `overlay` / `overlayOptions`. Two facts
follow: factories may return a promise, and the factory receives the theme as its second
argument — the value the bridge can hand to providers as part of their row-building
context.

## 4. Why duck-typing fails: the menu is sealed

gentle-shell builds its customize view inside the factory and returns something else:

- `extensions/gentle-shell.ts:3550` — `customizeView = new VisualCustomizeView({ rows, ... })`
- `extensions/gentle-shell.ts:3554-3561` — the factory returns a plain adapter:
  `{ render, handleInput, handleMouse, focus, invalidate, dispose }`
- `extensions/gentle-shell.ts:3562` — the call itself passes
  `{ overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 60, maxHeight: "85%" } }`

The view lives only inside those closures. There is no `options.rows` on the returned
object, at any depth the bridge can see. This is precisely the bug that made a first
prototype a silent no-op: it inspected the component, found no rows, and did nothing.

## 5. The one reachable moment

The view's constructor derives its categories from the rows array, synchronously, inside
the factory call:

```ts
this.categories = [...new Set(options.rows.map(row => row.category ?? "Settings"))];
```

`lib/visual-customize-view.ts:387`.

That `.map` runs before the factory returns and on the array the renderer will keep using.
So the bridge temporarily replaces `Array.prototype.map` for the duration of that single
call, records the row-like array **by reference** (not a copy), and restores the original
in a `finally` block. Restoring in `finally` is mandatory: an exception anywhere in the
factory must not leave the process with a patched `Array.prototype`.

Two properties make the captured reference live data rather than painted text:

- `categoryRows()` re-filters `this.options.rows` on every render
  (`lib/visual-customize-view.ts:391-393`), so rows pushed after construction appear.
- `component.invalidate()` on the returned adapter delegates to `view.invalidate()`
  (`extensions/gentle-shell.ts:3559`), which refreshes the frame.

Capturing an array reference is also why a marker on the captured array (non-enumerable,
via `Object.defineProperty`) matters: a second factory call for the same menu hands over
the same array, and rows must be injected once.

A mapped array counts as row-like when it holds at least three objects that each expose a
callable `action`. The threshold comes from the probe's verified run against the real menu;
the cost is explicit: a menu with fewer than three host rows would not be captured, and the
`/bridge-status` command reports `uncaptured (no-capture)` rather than passing silently.

### Capture-selection rule

Each wrapped `custom` call owns one capture *session* with its own candidate list, and
the probe records a mapped array into the innermost active session only. That fixes
the target without guessing:

- A nested `custom` call — from the host factory or from a provider's own `rows()` —
  gets its own session, so it can never steal the outer menu's capture, and the nested
  menu receives its own injection.
- A nested session whose factory throws never resolves, so nothing is injected into
  it; the outer session continues and resolves its own array.
- When one session captures **more than one** row-like array (an incidental
  row-shaped array before the menu, for example), the bridge does not guess: the
  outcome is `uncaptured (ambiguous)` and nothing is injected.

Arming is idempotent per target *and per function*: the non-enumerable marker holds the
exact wrapper installed and is read as an own property, so a rebind that gives an
instance a new `custom` always rearms even when it inherits an already-wrapped
prototype.

Two boundaries around that rule:

- The probe is installed around the **factory invocation**, not around the host call, so a
  host that resolves its factory in a later microtask (`Promise.resolve().then(factory)`)
  is still captured. A factory that itself returns a promise remains the documented
  unsupported case, `uncaptured (async-factory)`.
- Every wrapper carries the generation it was armed in. `disableCaptureBackend()` bumps the
  generation, so a wrapper that foreign code kept a reference to becomes a pass-through
  instead of injecting into a menu after the backend was switched off.

## 6. Why one bridge beats N wrappers

Two independent map-swapping wrappers chain badly. Whichever installs its patch last sees
the factory's `.map` call first and captures the array; the other captures nothing and
degrades to a warning. The result is that only one plugin's rows apply, non-deterministically
with load order, and the losing plugin looks broken for reasons it cannot debug.

The bridge installs **one** patch, guarded by a nesting counter (the factory may itself
trigger further UI work), and fans the single capture out to every registered provider:

1. snapshot the provider list in subscription order,
2. build each provider's rows independently, inside its own `try`,
3. drop a provider's rows on throw, record the failure for `/bridge-status`, continue,
4. push the surviving rows into the captured array and invalidate once.

Failure isolation is per provider, so a broken plugin costs its own rows and nothing else:
not the menu, not the other providers.

## 7. Process-global state cannot live in a module

Pi loads each extension through its own jiti loader with `moduleCache: false`; gentle-shell
documents the consequence directly — every extension gets a copy of any imported module
(`lib/shell-card.ts:30-32`). Shared state must therefore sit on `globalThis` behind a
`Symbol.for` key, exactly as gentle-shell does for its card style
(`lib/shell-card.ts:40-41`): `Symbol.for("gentle-pi.card-style")` indexing an augmented
`globalThis`.

The npm package is a typed facade over that process-global bus. Registration, diagnostics
and the capture marker all resolve through the same `Symbol.for` slot, so three providers
loaded from three copies of the package see one bus.

The bridge's own key is `Symbol.for("gentle-shell-bridge.providers")` for the registration
list, with sibling slots for backend state and markers (`…capture.state.v1`,
`…capture.wrapped.v1`, `…capture.injected.v1`, `…hook.state.v1`, `…hook.armed.v1`,
`…store.state.v1`). The host key `Symbol.for("gentle-pi.customize-row-providers")` is only
ever **read**: the bridge pushes one fan-out provider into it when a host exposes one, and
otherwise leaves the slot absent.

## 8. Row grouping semantics the bridge relies on (it does not re-implement them)

- `lineEntries()` coalesces **consecutive** rows that share `choice.setting`
  (`lib/visual-customize-view.ts:395-401`): same setting, adjacent index, one line. Same
  setting with another row between it becomes two lines with independent bullets.
- `renderSettingLine()` prints `entry.setting` as the line's name and marks each value with
  `●` for current and `○` for the others (`lib/visual-customize-view.ts:583-595`).
- `choice.hint` feeds the preview headline (`lib/visual-customize-view.ts:745`).
- `applyOnMove !== false` makes ←/→ apply a choice immediately rather than Enter
  (`lib/visual-customize-view.ts:565`).
- After any action the view requests its own re-render
  (`lib/visual-customize-view.ts:579`), so a plugin that persists inside `action()` sees an
  updated `●` without asking for a repaint.
- `category` is typed to a closed union of existing categories
  (`lib/visual-customize-view.ts:105`); full row shape at `:107-128`, inline helpers at
  `:129-140`.

The bridge ships no renderer. Every visual behaviour above belongs to gentle-shell, which
is why the contract can promise row kinds without promising pixels.

## 9. Reference implementation

`/home/jona/.pi/agent/extensions/loon-customize-probe.ts` (76 lines) is a throwaway probe,
not production code, and it implements exactly this capture trick. Confirmed in the real
TUI: the `Cards` category rendered `Cards · 1/3` with the injected line
`Card bash   ● activity ○ output`.

The probe is behavioural evidence for the backend, and it is also the honest baseline for
its weaknesses: probe-local state resets on `/reload` (no persistence), it recognises the
row array by shape, and it warns through `ctx.ui.notify` rather than through a diagnostics
surface. The package replaces all three.

## 10. Detection and reporting

Every branch that can end with "no rows appeared" is a reportable outcome on the `/bridge-status`
command: armed but never captured, captured a row array that failed the shape check,
provider threw, provider returned nothing, duplicate `category` + `setting` across
providers. Silent success is not a valid state.

## 11. Backend selection and module boundaries

Arming happens once per `ctx.ui` object, from `session_start` in `src/extension.ts`. The
order is fixed: if `globalThis[Symbol.for("gentle-pi.customize-row-providers")]` exists and
is usable — a plain array, or an object with a callable `register` — the bridge pushes one
fan-out provider and patches nothing at all. A present-but-unusable registry — or one that
does not accept the provider, because `push` did nothing, `register` returned `false`, or
either threw — is reported as `fallback-capture` and the capture backend is used instead,
never silently ignored. Dedupe does not mutate the host registry: identity in a
`WeakSet` in the process-global state is authoritative, so a frozen registry still gets
exactly one provider across arms and package copies. When the host removes the slot,
diagnostics stop reporting `hook`.

| Module | Owns |
| --- | --- |
| `src/index.ts` | the plugin-facing API: `registerRows`, `registerSection`, `createStore`, `STORE_SCHEMA_VERSION`, `VERSION`, `bridgeApi`, `isBridgeApi`, types; importing it also publishes the handshake through `./api.ts` |
| `src/api.ts` | the runtime handshake: the one `Symbol.for` slot, the frozen published object, the shape gate, `bridgeApi()` and publication |
| `src/extension.ts` | the Pi entry from `pi.extensions`: `session_start` arming (rows + sidebar widget), the `Sections` provider, and the `/bridge-status` command |
| `src/arm.ts` | backend selection and the arm result |
| `src/capture.ts` | the single `Array.prototype.map` patch and the captured array |
| `src/hook.ts` | the host-registry probe and the one fan-out provider |
| `src/bus.ts` | the `globalThis` provider list and its ordered snapshot, plus the section registry |
| `src/rows.ts` | the one row builder both backends call, with per-provider isolation |
| `src/sidebar.ts` | the rail interception: the state symbol, the patched `parts` map, the rail wrapper |
| `src/sidebar-render.ts` | the section renderer: card rows and groups per frame, clipping, failures |
| `src/sections-rows.ts` | the bridge's own `Sections` toggle rows |
| `src/visibility.ts` | bridge-owned section visibility in the namespaced store |
| `src/store.ts` | `createStore`, the namespaced path and the atomic write |
| `src/status.ts` | the `/bridge-status` text |
| `src/config.ts`, `src/types.ts` | config-home resolution; the row, provider and context types |

Because both backends call `src/rows.ts`, a plugin sees the same `registerRows` semantics on
either one. Because the arming markers live on the target objects and the state slots live on
`globalThis`, a second copy of the package arms nothing new and reads the same diagnostics.

## 12. The sidebar surface

The second surface a plugin can publish to. Same shape as the rows: one process-global registry,
one interception, one place that reports why nothing appeared.

### Where the rail lives, verified

- Rail state hangs on the **terminal** behind
  `Symbol.for("gentle-pi.experimental-sidebar.state")`, not in module scope
  (`lib/shell-sidebar.ts:6,78-80`), so separately loaded extensions share one rail.
- `sidebarPart` writes the part into `state.parts` (`:88`) and deletes it on dispose (`:92-95`).
- The layout paints a hard-coded key order — `["todo","jobs","agents","footer"]`
  (`lib/shell-sidebar-layout.ts:344`) — so an unknown key never renders: appending to an
existing part is the only way in, and the `footer` part is painted last.
- A part's cards come from `cardGroups` (`:392-410`) fed into `sectionCardRows` (`:35-44`), which
  is why a wrapped rail can look native: the host draws the frame, we supply rows and ranges.
- The status sections (`CHANGES`, `STATS`, `INTEGRATIONS`) are built inline in a closure
  (`lib/shell-bar.ts:247,251-316`): unreachable, so no interleaving is possible.
- The host's own `footer` part is registered at `extensions/gentle-shell.ts:2681`; readers reach
  another part's `spend` through `parts.get("agents").spend()` (`:2652`), which is why every field
  of the wrapped part is forwarded untouched, `digest` included (the layout memo keys on it).

### The interception

`src/sidebar.ts` patches the **map instance's own** `set` and `get` instead of replacing the map or
subclassing it: every holder keeps the map it already has, so a part registered after our arm is
still captured, and a part registered before it is wrapped on install. Two markers keep it
idempotent across arms, rebinds and package copies: the map's own property holds the exact `set`
function installed, and the wrapper rail holds the exact rail it wraps. A foreign wrapper already
on the part is wrapped around, never replaced; `disableSidebarBackend()` restores the host's part
and leaves any retained wrapper as a pass-through (a generation guard).

### The renderer

`src/sidebar-render.ts` contributes the section rows and their card groups per frame. A hidden
section is not built at all; a throwing `lines()`/`meta()`, a sparse array or a non-string row
loses only that section's body and is recorded for `/bridge-status`. Rows are clipped to the width
the host passes and the body is capped at 8 rows with a visible `… +N more` marker. Width is
measured in **UTF-16 code units**, not terminal columns, and a plugin that emits ANSI owns its own
width — the bridge does not parse or strip escape sequences.

### Acquiring a `tui` — and what is unconfirmed

A rail state is reached through a `tui` (`sidebarState(tui)` reads `tui.terminal`). Pi exposes
**no `tui` getter**: `ExtensionUIContext` in `dist/core/extensions/types.d.ts` mentions `TUI` only
as a factory parameter. The only surfaces that hand an extension's factory the real TUI are
`ctx.ui.setWidget(key, (tui, theme) => Component)` — `interactive-mode.js:1998`,
`content(this.ui, theme)` — plus `setFooter` (`:2084`), `setHeader`, `custom` and
`setEditorComponent`, and each installs a rendered component. gentle-shell itself gets its `tui`
this way (`extensions/gentle-agents.ts:2165-2175`).

So `src/extension.ts` installs a widget factory that keeps the `tui` it receives and returns a
component whose `render()` is `[]`. A missing `setWidget`, or a factory the host has not run yet, is
recorded as `no-widget-surface` and reported as `sidebar: not armed (reason)`.

**UNCONFIRMED:** whether a widget component that renders zero rows leaves the editor area visually
untouched has not been observed in a running Pi TUI. Nothing in the docs says either way; the
empty component is the minimal guess, and it is listed here rather than claimed.

## 13. Runtime discovery: a frozen object, not a path

How a plugin that does not depend on this package reaches it. Everything above assumes the plugin
already holds `registerRows` / `registerSection`; this section is how it gets them with nothing
installed, configured or imported.

### What Pi does and does not offer

- **No service registry.** Pi's extension API (`docs/extensions.md`) exposes registration calls
  (commands, tools, providers, MCP servers, handlers) but no lookup that returns another
  extension's live object. There is nothing a plugin could call to ask "is gentle-shell-bridge
  loaded?".
- **`pi.events` is the only sanctioned cross-extension channel** (`docs/extensions.md:1965-1972`,
  "Shared event bus for communication between extensions"), and it is a notification bus:
  `emit`/`on` delivers values to listeners at emit time. It is not a registry the host reads
  synchronously while it builds the menu. gentle-shell builds its rows inside the `ctx.ui.custom`
  factory (§5) and reads the rail map at render time (§12), so a plugin reachable only through an
  event handler cannot put rows into either. Events are not the seam.
- **`globalThis` is the one object two separately loaded extensions already share** in one
  process, and gentle-shell already relies on it: one stable `Symbol.for` key per piece of
  process-global state (`lib/shell-card.ts:40-41`, `lib/card-content-policy.ts:78`,
  `lib/shell-sidebar.ts:6`), because Pi loads every extension through its own jiti module
  instance (§7).

### The convention this follows

- `pi-lens` mounts its IO bridge at a stable `Symbol.for` key with a version constant, first-wins
  and frozen, and a breaking major takes a **new** symbol key instead of mutating the old slot
  (`clients/io-bridge-contract.ts:25-32`, `clients/process-bridge.ts:48-81`).
- gentle-shell names its shared payloads with a `schema` string and gates on the exact shape
  before using them (`lib/card-content-policy.ts:11,40`, `lib/card-style-policy.ts:29`).

The bridge combines the two. `Symbol.for("gentle-shell-bridge/api/v1")` holds a frozen object
carrying the schema string, the major version and the three callable members, and the consumer
checks all of them with `isBridgeApi` (`src/api.ts`). `v1` in the key is the major: `v2` is a new
key and `v1` is never mutated.

### First wins, and consumption at `session_start`

`src/api.ts` publishes at module load — importing `./extension.ts` or `./index.ts` loads it — so
the API exists before any `session_start`. A compatible object already in the slot is kept and
returned untouched. An incompatible one is left exactly where it is (never overwritten, deleted
or reset); this copy's own object still works for registration and operates on the same
process-global bus (§7).

A plugin registers from its own `session_start` handler. Pi completes every extension module's
async initialization before firing that event (`docs/extensions.md:213`), so the handler either
finds the object or learns the bridge is not installed. The symbol's presence is the complete
answer: there is no deferred path and no second publication point. `bridgeApi()` returns the
object or `undefined`, and registration is idempotent because it is by stable id.

### Why a path, and why an environment variable, were rejected

A path is not a contract between two independent projects: it names one checkout on one machine,
reaches into another package's files, and breaks silently the day either repository moves. An
environment variable is the same problem plus a per-user setup step, so the feature stops working
until someone is told to set it — not "zero extra steps". Both were in the worked example
(`bridgeCandidates()`, a dynamic `import()`, `GENTLE_SHELL_BRIDGE_MODULE`) and both are gone: the
example now inlines the symbol and the gate (`examples/bash-card.ts`) and registers from
`session_start`.

### Version skew

An object that fails the gate — another library's payload, another major, a partial object — is
**absent**, never an error and never half-used: `bridgeApi()` returns `undefined`, the plugin
decides what to do, the bridge emits one warning per process, and the slot is left for whoever
wrote it. A newer plugin against an older bridge therefore sees "absent" instead of being
deferred silently; that compatibility cliff is intentional.

## Limits

- **Internals, not an API.** Everything here depends on one constructor line, one adapter
  shape and one call chain in code gentle-shell does not export. No upstream row-provider
  hook exists today.
- **The hook backend is unverified.** `Symbol.for("gentle-pi.customize-row-providers")` is
  accepted as a plain array or an object with a callable `register`, and anything else is
  reported as unusable so the capture backend takes over. No host has been observed emitting
  that registry, so the pushed provider's shape (`{ id, rows }`) is an inference.
- **`Array.prototype.map` is patched**, briefly: one synchronous factory call, restored in
  `finally`. A callback that stores the patched function for later use is out of scope;
  nothing in the observed chain does that.
- **Capture is heuristic.** A menu that builds rows through a different array (or not at
  all) yields no capture. Reported, never silent — but not fixed.
- **No new categories.** The renderer's `category` is a closed union of existing categories
  (`lib/visual-customize-view.ts:105`) while the bridge's `CustomizeRow.category` is a
  `string`, so a category gentle-shell does not already render renders nothing.
- **Tests exercise a fake host, not the TUI.** The suite runs under `node --test`; the end-to-end
  ones drive a fake host that models `gentle-shell.ts:3550-3562` and a fake sidebar that models
  `lib/shell-sidebar.ts` + `lib/shell-sidebar-layout.ts`'s card frame. The capture technique itself
  is verified in the real TUI only by the reference probe; the sidebar section surface has never
  been seen in one.
- **Sections cannot be interleaved.** They render after every native card, by construction (see
  §12); a request to slot one between `CHANGES` and `STATS` is not supported.
- **The sidebar widget's visual footprint is unconfirmed** (see §12): the `tui` is acquired through
  a widget factory, and whether an empty component is invisible has not been observed.
- **Async factories are reported, not supported.** `Promise.resolve(factory(...))` accepts a
  promise (`interactive-mode.ts:3136`), but the capture window closes with the synchronous
  call. A promise-returning factory is returned untouched and recorded as
  `uncaptured (async-factory)`, so no rows are injected; this is a test case, not a fix.
- **The runtime handshake is proven in-process.** The suite resets `globalThis`, simulates an
  early loader and loads the real example more than once under `node --test`; two live Pi
  extensions loading in either order inside one running session have not been observed, and
  neither has a real second major version at the slot (the skew branch is driven by a fake
  object).
