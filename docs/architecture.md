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

## 6. Why one bridge beats N wrappers

Two independent map-swapping wrappers chain badly. Whichever installs its patch last sees
the factory's `.map` call first and captures the array; the other captures nothing and
degrades to a warning. The result is that only one plugin's rows apply, non-deterministically
with load order, and the losing plugin looks broken for reasons it cannot debug.

The bridge installs **one** patch, guarded by a nesting counter (the factory may itself
trigger further UI work), and fans the single capture out to every registered provider:

1. snapshot the provider list in subscription order,
2. build each provider's rows independently, inside its own `try`,
3. drop a provider's rows on throw, record the failure for `status`, continue,
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

Every branch that can end with "no rows appeared" is a reportable outcome on the `status`
command: armed but never captured, captured a row array that failed the shape check,
provider threw, provider returned nothing, duplicate `category` + `setting` across
providers. Silent success is not a valid state.

## Limits

- **Internals, not an API.** Everything here depends on one constructor line, one adapter
  shape and one call chain in code gentle-shell does not export. No upstream row-provider
  hook exists today.
- **`Array.prototype.map` is patched**, briefly: one synchronous factory call, restored in
  `finally`. A callback that stores the patched function for later use is out of scope;
  nothing in the observed chain does that.
- **Capture is heuristic.** A menu that builds rows through a different array (or not at
  all) yields no capture. Reported, never silent — but not fixed.
- **No new categories.** `CustomizeRow.category` is a closed union of existing categories,
  so the bridge adds rows only to categories gentle-shell already renders.
- **No automated tests.** The evidence is one manual TUI run plus source reading; the
  extraction has not yet been exercised by a test suite.
- **Async factories are assumed, not exercised.** `Promise.resolve(factory(...))` accepts a
  promise (`interactive-mode.ts:3136`), but the capture window closes with the synchronous
  call, so a factory that builds its rows in a later microtask is unproven.
