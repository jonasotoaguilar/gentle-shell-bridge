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

The bridge's own rows obey the same rule. Its `Sections` and card-style rows put a human label in
`choice.setting` (`music`, `plain`) and in the row's `label` — never a registration id, which would
read as the old `Section: bash-card.status` (`src/row-labels.ts`). Identity stays in the registry, so
replacement, disposal and the stored visibility key remain keyed by id while nothing id-shaped is
rendered. Two sections whose labels would read the same are disambiguated in render order
(`music`, `music 2`, …) and `/bridge-status` reports the assignment in force.

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

### The plugin's own INTEGRATIONS line

The host renders Pi's extension-status map (`footerData.getExtensionStatuses()`) as the INTEGRATIONS
card: one row per entry, plus the permissions row (`extensions/gentle-shell.ts:357-385`,
`lib/shell-bar.ts:289-298`). A row is the WHOLE opaque string the extension set via
`ctx.ui.setStatus(key, text)`; the host strips its ANSI and paints every entry with one shared role,
so a glyph must live inside the text and colour belongs to the host (`lib/shell-bar.ts:151-155`).
`undefined` removes a key, which is what `session_shutdown` uses.

Because the host has no notion of "a plugin", the bridge owns exactly one key per plugin
(`src/plugin-lines.ts`). Attribution needs no configuration from the author: every registration in
`src/bus.ts` goes through `attributeRegistration`, which reads the calling module from the stack
once per registration (the first frame outside this package's `src/`), walks up from it to the
nearest `package.json` with a non-empty `name`, and caches that answer per module. Three outcomes:
another package (a plugin, whose display name is derived from the package name), this package
(plumbing — the bridge's own providers and fallbacks never claim a row), and no owning package (a
single copied file: fail closed, no row, reason in `/bridge-status`). An optional `name` on the
plugin's first registration overrides the derived name and is the documented way for such a file to
name itself; it is validated against the row-name shape, never rewritten.

One key per plugin is hashed from the package root (or the module path when it has no owner), so a
plugin's ten registrations update one row in place instead of adding ten. The text is
`<name> · <ready|degraded>`: `ready` is derived — one rejected registration (an invalid id, a row
label that broke the shape rule) repaints the same key as `degraded`. `installPluginStatus` runs on
`session_start` (for plugins that registered before any `ctx.ui` existed) and paints or repaints;
`clearPluginStatus` runs on `session_shutdown` and clears every key this module set with `undefined`.
A `ctx.ui` without `setStatus` makes the feature a reported no-op: nothing here can throw into a
plugin's registration path.

What is proven where: the bridge's side is tested against a fake footer (an object with
`setStatus`), plus real temporary plugin packages for attribution. The host's rendering — sort
order, shared role, ANSI stripping — is read-only evidence from gentle-shell, not executed here.

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
| `src/index.ts` | the plugin-facing API: `registerRows`, `registerSection`, `registerCardStyle`, `registerTransform`, `createStore`, `STORE_SCHEMA_VERSION`, `VERSION`, `bridgeApi`, `isBridgeApi`, types; importing it also publishes the handshake through `./api.ts` |
| `src/api.ts` | the runtime handshake: the one `Symbol.for` slot, the frozen published object, the shape gate, `bridgeApi()` and publication |
| `src/extension.ts` | the Pi entry from `pi.extensions`: `session_start` arming (rows + sidebar widget), the `Sections` provider, and the `/bridge-status` command |
| `src/arm.ts` | backend selection and the arm result |
| `src/capture.ts` | the single `Array.prototype.map` patch and the captured array |
| `src/hook.ts` | the host-registry probe and the one fan-out provider |
| `src/bus.ts` | the `globalThis` provider list and its ordered snapshot, plus the section, card-style and transform registries |
| `src/rows.ts` | the one row builder both backends call, with per-provider isolation and the row-name shape check |
| `src/row-names.ts` | the enforced row-name shape (one to three plain words, no structural marks) and the rejection records `/bridge-status` lists |
| `src/sidebar.ts` | the rail interception: the state symbol, the patched `parts` map, the rail wrapper |
| `src/sidebar-render.ts` | the section renderer: card rows and groups per frame, clipping, failures |
| `src/sections-rows.ts` | the bridge's own `Sections` toggle rows |
| `src/row-labels.ts` | the visible label for those rows: `rowLabel` or a derived one (clamped to the shape), plus the deterministic collision assignment (never an id) |
| `src/visibility.ts` | bridge-owned section visibility in the namespaced store |
| `src/store.ts` | `createStore`, the namespaced path and the atomic write |
| `src/status.ts` | the `/bridge-status` text |
| `src/transform-pipeline.ts` | the ordered per-frame transform pass: width clipping, throw isolation and the last frame's outcomes |
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

### The `Sections` toggle names

`src/sections-rows.ts` builds the toggle from the live registry on every menu build, and
`src/row-labels.ts` decides what it reads: the author's `rowLabel`, else the title made readable
(lowercase words, dots and punctuation dropped, clamped to three words). The label is BOTH the row's
`label` and the line's `choice.setting`, because the host prints the setting as the line's name
(`lib/visual-customize-view.ts:583-595`); the section id never reaches either. Equal labels are
resolved in render order with the lowest free ordinal suffix, and `collectStatus()` uses the SAME
function, so the menu and `/bridge-status` cannot disagree about which section reads `music 2`.
Status output keeps the ids on purpose: it is read by the plugin author diagnosing a registration,
not by the user picking a toggle.

The LABEL TEXT has one shape (`src/row-names.ts`), because a row named `Bash card → Bash rendering`
was the third defect of its class: one to three plain words, no arrow, colon, dot, pipe, slash or
bracket. It is enforced at both boundaries that can create a row name, and never by rewriting the
author's text: a section or card style whose `rowLabel` breaks the shape is not stored at all, and a
provider row whose line name or label breaks it is dropped as `buildRows` stages it — absent from the
host's array and from the build record `collectStatus()` reads, so it is not part of the effective
set. The rejected string is recorded verbatim with the rule it broke and `/bridge-status` prints both
under `row name rejections`. Derivation from `title`/`label` applies the same shape (marks become
word breaks with the rest of the punctuation; the result is clamped), so a derived name can never be
rejected.

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
  event handler cannot put rows into either. Events are not the seam for *delivery*. They are the
  only way to learn that a package loaded later published something, which is what the announcement
  below uses — and why it carries a signal ("look again") instead of the API itself.
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

### First wins, and the publication announcement

`src/api.ts` publishes at module load — importing `./extension.ts`, directly or through the package
root — so the API exists as soon as the package has been loaded. A compatible object already in the
slot is kept and returned untouched. An incompatible one is left exactly where it is (never
overwritten, deleted or reset); this copy's own object still works for registration and operates on
the same process-global bus (§7).

### The load order, as observed rather than assumed

This design first claimed that `session_start` arrives only after every extension module has
initialized, so a plugin's handler either found the object or knew the bridge was absent
(`docs/extensions.md:213`). A real TUI disproved it: `/bridge-status` showed a working bridge
(`backend: capture`, `sidebar: intercepted`, `card style wiring: chat wrapped`) while the worked
example — a global extension in `~/.pi/agent/extensions` — reported "no compatible
gentle-shell-bridge is installed". Global extensions load, and receive `session_start`,
before a configured package's module publishes. The symbol was read too early, not missing.

So an absent slot at `session_start` means "not yet". Two mechanisms answer that, and they stay
separate on purpose:

1. **the symbol** remains the only authority for *which* object to use (`isBridgeApi`, first wins);
2. **`gentle-shell-bridge:ready`** tells the process *when* a publication happened. It is emitted
   from `announceBridgeReady` at the extension factory — the first moment `pi.events` exists —
   exactly once per process (a `globalThis` flag like every other piece of process state, §7), and
   never when the slot holds an incompatible payload, because there would be nothing to look at.

A listener never receives the API: it waits for the signal and reads the symbol again, so the gate,
the first-wins rule and the "absent is absent" rule are unchanged. `onBridgeApi(handler, pi.events)`
is the helper form — immediate when the object is already published and a subscription when it is
not, with the subscription detaching itself after one delivery. Registration stays idempotent by
stable id, so a plugin that registers from `session_start` *and* from the announcement leaves one of
each surface, and the announcement can arrive before or after the session event without either path
having to know about the other.

What was rejected: a queue inside the bridge (a plugin's registrations waiting invisibly for a
version that may never load — the previous revision of this file described exactly that and removed
it), and retrying `session_start` on a timer (no event to hang it on, and the plugin would have to
keep state it does not need). The announcement is neither: one event, no holding area, and the
plugin decides what an absent-and-unannounced bridge means for it.

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

## 14. The card-style transform

The third surface. Rows and sections add something to the menu and the rail; a card style cannot be
added at all in the way the others can — the host draws the conversation itself, `CARD_STYLE` is a
two-member union (`lib/shell-card.ts:33-38`) read in eight places, all binary, and
`cardStyle()` normalizes any unknown value to `float` (`:43-45`). So the bridge does the only thing
the host allows: it lets gentle-shell draw, then repaints the frames the host already produced.

### Where the conversation component is, and how that was proven

The full derivation, with every citation, is the evidence block at the top of `src/card-styles.ts`
(§1). In short, from the `tui` Pi hands a `ctx.ui.setWidget` factory (`src/extension.ts:108-109`):

1. **Primary:** `tui.children[0]` → the document container → `children[2]` (the chat container).
   `children` is a declared member of the public `TUI` interface (`pi-tui/dist/tui.d.ts:223-231`)
   and Pi fills it in both renderer modes, document first
   (`pi-coding-agent/dist/modes/interactive/interactive-mode.js:623-625,722-731`); the document's
   children are `[header, loadedResources, chatContainer]` (`:404-407`).
2. **Secondary:** `tui.layoutRoot` → its layout entries → `entries[0].component`, the primary
   `ScrollView` (`dist/modes/interactive/chat-viewport.js:4-11,22-25`) → that view's child through
   the layout protocol (`pi-tui/dist/components/scroll-view.d.ts:57`,
   `layout-node.d.ts:2,36-38`) → the same document. `layoutRoot` is TypeScript-`private` and exists
   only on the fullscreen renderer (`tui-alt-screen.d.ts:44`), which is why it is second.
3. Anything else is reported, never guessed: `no-tui`, `no-children`, `no-document`,
   `no-conversation`, `render-missing`, `wrong-shape` (a host accessor that throws). `/bridge-status`
   prints the outcome, so "no repaint" is always an answer.

### The transform

`src/card-style-transform.ts` wraps that component's `render(width)`: the host's own render runs
first (a host failure stays the host's), then the rows are handed to the detector. It recognises
exactly the `float` grammar (`src/card-styles.ts` §2): a one-column margin, the `▎` bar, then
padding / header / optional separator / body / padding, with an empty-body card folded to three rows.
A `neon` card starts at column 0 with `╭`, `│` or `╰` and is never touched. Rows that are not cards
come back as the same strings; with `native`, no selection, or a selection naming a style that no
longer exists, the input array itself is returned. A style's three functions get the measured width
and the extracted heading; anything wider than the width is clipped before it is emitted, and the
frame is abandoned wholesale if any style call throws (a card is never half-repainted).

### Wrapping once, and staying wrapped

`src/card-style-wiring.ts` is armed from the same widget factory that captures the `tui` — never at
module load — and follows the sidebar backend's discipline (`src/sidebar.ts:52-90`): an own-property
marker certifies the exact `render` function installed, so a rebind, a second `session_start` or a
second copy of this package reports `already-wrapped` instead of stacking wrappers. The wrapper
captures a generation; `disableCardStyleTransform()` restores the host's own `render`, deletes the
marker and bumps the generation, so a wrapper foreign code retained becomes a pass-through rather
than an injector. The same rule governs a retained *style*: a disposed style resolves to `missing`,
and `missing` is the pass-through.

### The rail: a second surface, one transform

The rail frames its own cards — `sectionCardRows`/`headerParts` over `floatRows`/`cardTop`/
`cardLine` (`lib/shell-sidebar-layout.ts:36-47`), host sections and contributed sections through the
same call — and it frames them AFTER a part hands over its rows. A part therefore cannot restyle its
own card, and wrapping the contributed part would only ever reach the rows it contributed. The
reachable seam is one level up: the framed rows are the child of the rail's `ScrollView` in the
layout tree (`lib/shell-sidebar-layout.ts:486-499`; `ScrollView[LAYOUT_NODE]()` reports its child,
`pi-tui/dist/components/scroll-view.js:191-192`), so wrapping that component's `render(width)` sees
every rail frame the host produced — its own sections and ours, in one place.

`src/card-style-wiring.ts` walks that tree by SHAPE (the root's layout node → the `hstack` → its
second entry → that scroll view's child), never by index into the root, and requires the candidate to
expose both a layout protocol and a `render`. The wrapper is the conversation's wrapper with one
difference: the rail runs ONLY the card-style repaint. The registered transcript transforms are the
conversation's extension point (their contract is "the conversation's rows"); handing them the rail
would let a plugin corrupt a surface it never claimed. Every absence is a reported outcome
(`no-layout-root`, `no-sidebar`, `no-rail`), recorded per surface for `/bridge-status`.

### A write repaints its surface

The rail and the conversation both display bridge-owned state: a section's visibility, and the
card-style selection. Persisting is not painting — gentle-shell re-renders a rail part only when its
digest changes or its layout revision moves (`lib/shell-sidebar-layout.ts:310-350`), so a
bridge-owned row used to change the store and leave the screen alone until something else repainted
it. `src/repaint.ts` performs the two steps gentle-shell's own part owners perform
(`lib/shell-sidebar-layout.ts:105-107`, `extensions/gentle-agents.ts:2147-2148`), synchronously,
inside the row's `action()`: bump `tui.terminal[CACHE].revision` (the documented
`invalidateSidebar(tui)` effect, reached through the host's published symbol because this package
cannot import the host's modules) and call `tui.requestRender()`. No timer, no poll, no retry, and no
frame when the write changed nothing. An unavailable path is recorded and reported, not swallowed.

### The conflict that cannot be won

A post-processor downstream of this bridge can wrap the chat container's `render` and strip any box
chrome it finds — a class of consumer that re-frames the conversation, and the frame that reaches
the screen is the last one written. That can erase this frame on exactly the cards it re-frames —
bash in particular. The bridge cannot prevent that, does not try, and says so in `/bridge-status`:

> a downstream post-processor can strip or override this frame; the bridge cannot prevent it.

Nothing user-visible names such a consumer: the bridge ships to whoever installs it, and no package
it cannot see is allowed to be a prerequisite for its own report.

### Why not ask gentle-shell to add a style registry

Rejected in [state.md](state.md) (§Alternatives rejected, F/G). The package exists because the host
does not take every change; a design that waits for one is not a bridge.

## 15. The transform pipeline

The fourth surface. §14 explains how the bridge reaches the conversation component; this section
is what that wrapper does with the rows it intercepts, now that it serves more than one feature.

### One wrapper, an ordered pipeline inside it

`src/card-style-wiring.ts` installs a single `render(width)` wrapper on the conversation component.
Inside it the host's own render runs first (a host failure stays the host's), then:

1. `transformCardLines` (`src/card-style-transform.ts`) repaints the selected card style, or returns
   the host's array unchanged when there is nothing to do;
2. `applyTransforms` (`src/transform-pipeline.ts`) runs every registered transform in order, handing
   each one the previous output and clipping what comes back to the width the host passed;
3. the result goes to Pi.

With no style selected and no transform registered, both steps return their input, so the host's own
array instance reaches Pi: the identity the card styles already promised is now the whole pipeline's
promise. The wrapper keeps the generation guard and the own-property marker unchanged, so a rebind, a
second `session_start` or a second package copy still resolve to `already-wrapped` instead of
stacking pipelines.

### Why the loop belongs to the bridge, not to each plugin

`pi.registerToolRenderer` resolves when a tool row is BUILT (`docs/extensions.md`, "Custom
Rendering"), so a rendering choice made through that slot can only reach the next row. Pi exposes no
API to repaint rows that are already drawn, and the component that renders them is not reachable
from a row's `action()`. The bridge already wraps that component for card styles, so the transform
layer is a widening of a proven path rather than a new interception: one loop, one place to clip, one
place to isolate a throw, and one place `/bridge-status` reads.

That is also why the worked example retired its `pi.registerToolRenderer` resolver: a resolver draws
its own component from the tool's arguments, while a transform can only restyle what the host
already drew. Keeping both would have meant two different pictures of the same card — the transform
for history, the resolver for new rows — which is exactly the asymmetry the feature exists to remove.
The transform is the single owner there, and `test/example-transform.test.ts` proves that a card
drawn before the switch and one drawn after it are byte-identical.

### Ordering, isolation and the width

`snapshotTransforms()` decides the sequence once per frame, with the same rule as sections and card
styles: an explicit `order` first, ascending, then registration order. A transform that throws, or
that returns something which is not an array of strings, is skipped for that frame — the lines in
force are kept and the remaining transforms still run — and the failure is recorded with its id and
message for `/bridge-status`. Whatever comes back is clipped with `clipToWidth`, so a transform
cannot make the frame wider than the terminal.

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
- **The card-style repaint is proven against a fake conversation, not a live one** (see §14). The
  fixture rows are real `lib/shell-card.ts` output, but the component tree is Pi's documented shape,
  and the downstream-override conflict (§14) cannot be reproduced without a second post-processor
  running in a real session.
- **A blank body row is byte-identical to a card's opener/closer** (`cardLine("")` is a bar and
  spaces), so a card containing a blank body row is detected as ending at that row; the remaining
  rows stay as the host drew them. A heading's hint is only split out when its style runs prove it,
  and the heading glyph is stripped by a one-character rule. Both are documented in the transformer
  and are the price of not parsing the host's intent.
- **Async factories are reported, not supported.** `Promise.resolve(factory(...))` accepts a
  promise (`interactive-mode.ts:3136`), but the capture window closes with the synchronous
  call. A promise-returning factory is returned untouched and recorded as
  `uncaptured (async-factory)`, so no rows are injected; this is a test case, not a fix.
- **The runtime handshake is proven in-process.** The suite resets `globalThis`, simulates an
  early loader and loads the real example more than once under `node --test`; two live Pi
  extensions loading in either order inside one running session have not been observed, and
  neither has a real second major version at the slot (the skew branch is driven by a fake
  object).
