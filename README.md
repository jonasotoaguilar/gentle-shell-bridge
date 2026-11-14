# gentle-shell-bridge

A shared, plugin-facing bridge between Pi plugins and gentle-shell's `/gentle:customize`
menu. A plugin publishes a *row provider*; the bridge owns the single interception layer
and fans out to every provider, so N plugins × M gentle-shell surfaces becomes N providers
and one interception. Plugins stop wrapping `ctx.ui` themselves, and stop colliding with
each other when more than one wants to add a settings row.

**Status: released as `0.2.0`.** The package exists and runs. It is a manifest-backed Pi
package (`pi.extensions` → `./src/extension.ts`) loaded from TypeScript sources through
jiti, so there is no build step and no `dist/`; it registers a `bridge-status` command and
carries a `node --test` suite of 328 tests, 26 of them end-to-end through the public API and
the real extension entry. The capture technique was proven in the real TUI by a 76-line
throwaway extension (`loon-customize-probe.ts`); the capture backend implements it, while
the hook backend is implemented but **unverified** — no host has been observed emitting the
registry it looks for. The sidebar surface is proven against a fake rail, not in a live TUI:
what is not proven is listed under **Limits**.

- [PRD.md](PRD.md) — problem, users, requirements, success criteria
- [docs/architecture.md](docs/architecture.md) — how the host menu is reached, with source citations
- [docs/contract.md](docs/contract.md) — `registerRows`, provider and row shapes, diagnostics
- [docs/state.md](docs/state.md) — ADR: stateless composition plus optional per-plugin store

## Worked consumer

[`examples/bash-card.ts`](examples/bash-card.ts) is a standalone Pi extension that covers both
surfaces the package sits between: its own bash card through `pi.registerToolRenderer`, a `Cards`
toggle through `registerRows` + `createStore`, and a **`BASH CARD` sidebar section** through
`registerSection`. The section reports the mode the user chose and whether this load actually wired
the bash renderer, and it is toggled from **`Sections`** in `/gentle:customize` — the plugin writes
no setting, row or store for it. Copy the file into `~/.pi/agent/extensions/` and `/reload` to load
it; the toggle defaults to `default`, so installing it changes no rendering until the row is
switched, while the section is visible immediately (`defaultVisible: true`). It does not import the
package and does not know where it is installed: the example and the bridge meet on `globalThis`
behind one symbol (see **Reaching the bridge without importing it**). It registers from its own
`session_start` handler, where the symbol's presence is the complete answer — if no compatible
bridge is installed the example says so once and adds nothing.

Both rows carry `preview()`, so `/gentle:customize` draws a literal sample of the card each
mode produces instead of "Preview unavailable".

A bridge that publishes something else — another major version, a partial object, another library's
payload at the symbol — is treated as absent, never as an error: the example never calls an object it
cannot trust, says so once through `ctx.ui.notify`, and registers nothing. The bridge reports the
version skew once per process.

The choice applies to the **next bash call**: the resolver runs when a bash row is built, not per
frame, so rows already on screen keep the rendering they were built with. Scrolling or `Esc` does
not re-render history, and Pi has no extension API that repaints already-drawn tool rows —
`tui.requestRender()` exists only inside a component created through `ctx.ui.custom`.

## Install

The package is `0.2.0`. Load it from source as a Pi extension package alongside gentle-shell
and Pi discovers `src/extension.ts` through the `pi` manifest. The shipped files are the
TypeScript sources: Pi loads them through jiti, so there is no build step and no `dist/` to
publish.

For a plugin that imports the API, `exports` maps the package root to `src/index.ts`:

```ts
import {
  bridgeApi,
  createStore,
  isBridgeApi,
  registerRows,
  registerSection,
  STORE_SCHEMA_VERSION,
  VERSION,
} from "gentle-shell-bridge";
```

Importing is optional: a plugin can reach the bridge through the runtime handshake below without
resolving the package at all.

`engines.node` is `>=22.18.0` because the test suite runs `.ts` files directly through
Node's native type stripping, with no transpile step.

## Quick start: a sidebar section

The two quick starts below show the call itself. Make it from your extension's `session_start`
handler, where the bridge is either present or absent — never somewhere that depends on load order.

The second surface needs no `Sections` row, no setting name and no store of its own — one call
adds the card to the sidebar and its show/hide toggle to `/gentle:customize` → `Sections`.

```ts
import { registerSection } from "gentle-shell-bridge";

const dispose = registerSection({
  id: "loon.music",             // unique and stable: ordering, replacement, the toggle
  title: "MUSIC",               // card heading, framed by the host like AGENTS / STATS
  meta: () => "1 playing",      // optional right-aligned count
  lines: () => ["track  Blue in Green", "album  Kind of Blue"], // per frame, live
  defaultVisible: true,
  order: 10,                    // optional; unordered sections follow, in registration order
});

// dispose() removes the card and its toggle; other sections are untouched.
```

What the bridge does with those fields, and what it will not do: the card is drawn by the
host's own frame code, the body is clipped to the rail width and capped at 8 rows (with a
`… +N more` marker; width is counted in UTF-16 code units, not terminal columns, and a plugin
that emits ANSI owns its own width), a hidden section is not built at all (its `lines()`/`meta()`
are not called), and a throwing section loses only its own body and is reported by
`/bridge-status`.
Sections always render **after** the native cards — interleaving is impossible because the
host builds its status sections in a closure. Visibility lives in
`~/.pi/gentle-ai/gentle-shell-bridge/bridge-sections.json` as
`{ "schemaVersion": 1, "values": { "sections": { "loon.music": true } } }`, deliberately not
in the host's strictly validated `visual-customization.json`.

## Quick start: a card style

A plugin can add a third card style to gentle-shell's conversation cards, on the host's own
`Card style` line, without touching the host. The bridge owns detection; the style owns drawing.

```ts
import { registerCardStyle } from "gentle-shell-bridge";

const dispose: () => void = registerCardStyle({
  id: "loon.cute",  // unique; the stored value and the replacement key
  label: "cute",    // shown on the line: Card style  ○ neon ● float ○ cute
  frame: {
    top: (ctx) => `╭─ ${ctx.title ?? ""} ${"─".repeat(Math.max(0, ctx.width - 6))}╮`,
    line: (ctx) => `│ ${ctx.text.padEnd(Math.max(0, ctx.width - 4))} │`,
    bottom: (ctx) => `╰${"─".repeat(Math.max(0, ctx.width - 2))}╯`,
  },
  preview: () => ({ title: "Cute", sample: "╭─ read ─╮ │ config.ts │ ╰────────╯" }),
});

// The user picks `cute` on the host's own Card style line; pressing neon/float returns to the
// host's rendering. dispose() removes the value and the chrome.
```

Rules the row cannot break: `id` and `label` are unique among the line's values (the host's
`neon`/`float` and the bridge's `native` are taken), and the style only ever receives text and a
width — it parses nothing. Full contract: [docs/contract.md](docs/contract.md) §12.

## Reaching the bridge without importing it

A plugin and the bridge are two independent projects, so a path to one checkout is not a contract.
They meet on `globalThis`, behind one stable symbol:

- `Symbol.for("gentle-shell-bridge/api/v1")` holds
  `{ schema: "gentle-shell-bridge/api", version: 1, VERSION, registerRows, registerSection, createStore }`.
  It is frozen, first-wins (a valid object already there is kept, not replaced) and never reset.

**Register from a `session_start` handler; then the symbol's presence is the complete answer.** Pi
finishes loading every extension module before it fires `session_start`
(`docs/extensions.md:213`), and the bridge publishes as its module loads, so your handler either
finds the object or knows the bridge is not installed. There is no holding area and nothing to wait
for. Inline the gate (the example does), or import the package and call `bridgeApi()`:

```ts
const KEY = Symbol.for("gentle-shell-bridge/api/v1");
const isApi = (v: any) => typeof v === "object" && v !== null && v.schema === "gentle-shell-bridge/api" &&
  v.version === 1 && typeof v.registerRows === "function" &&
  typeof v.registerSection === "function" && typeof v.createStore === "function";

pi.on("session_start", (_event, ctx) => {
  const api = (globalThis as any)[KEY];
  if (!isApi(api)) {
    ctx.ui?.notify("my-plugin: no compatible gentle-shell-bridge is installed", "warning");
    return; // it adds nothing; the plugin decides whether to continue or fail loudly
  }
  api.registerSection({ id: "loon.music", title: "MUSIC", lines: () => ["…"] });
});
```

A plugin that imports the package gets the same answer in one call:

```ts
import { bridgeApi } from "gentle-shell-bridge";

pi.on("session_start", () => {
  const api = bridgeApi();
  if (api === undefined) return; // absent, full stop: no waiting, no deferral
  api.registerRows({ id: "loon.banner-source", category: "Cards", rows: () => [] });
});
```

Rules worth knowing: an object that fails the gate (wrong schema, `version !== 1`, a missing member)
is **absent**, never an error — `bridgeApi()` returns `undefined`, one warning is emitted per
process, and the slot is left exactly as it was. A breaking change takes a new `v2` symbol key
rather than mutating `v1`. An older bridge publishes nothing at this key, so a newer plugin sees
"absent" instead of being deferred silently; that compatibility cliff is intentional. The full rule,
the three surfaces and complete snippets are in [docs/contract.md](docs/contract.md) §9.

## Quick start: rows

```ts
import { createStore, registerRows } from "gentle-shell-bridge";

const store = createStore("loon"); // ~/.pi/gentle-ai/gentle-shell-bridge/loon.json
const read = () => store.get("bannerSource", "activity");

const toggle = (value: string) => ({
  category: "Banner" as const,
  label: () => "Loon: banner source",
  choice: { setting: "Loon → Banner source", value, current: () => read() === value },
  action: () => store.set("bannerSource", value), // persist first; the menu re-renders
});

const dispose = registerRows({
  id: "loon.banner-source",
  category: "Banner",
  rows: () => [toggle("activity"), toggle("output")], // consecutive, same setting → one line
});

// dispose() removes every row this provider contributed; other providers are untouched.
```

## Supported row kinds

Every field below is already understood by gentle-shell's own renderer; the bridge only
carries rows, it does not interpret them.

| Kind | Shape | Renders as |
| --- | --- | --- |
| Toggle | two or more consecutive rows sharing `choice.setting` | one line `Name ● current ○ other`; ←/→ applies, Enter applies when `applyOnMove: false` |
| Action | a row without `choice` | one line; Enter/Space runs `action(inline)` |
| Gated | `visible()` returns `false` | row hidden; a throw fails closed and hides it |
| Preview | `preview()` returns `{ title, sample }` | read-only preview for the focused row |
| Inline editor | `action` calling `inline.input()`, `inline.confirm()`, `inline.capture()` | field, confirmation or key capture drawn inside the card |
| Hint | `keyhint` | per-row footer hint instead of the category default |

`label` may be a string or a function, and is evaluated when the menu is built, so it can
read live state. Full details, conflict policy and failure isolation:
[docs/contract.md](docs/contract.md).

## Diagnostics

The bridge registers one command, `/bridge-status`. It reports the registered providers (id
and category, in subscription order), the active backend (`hook` or `capture`), the last
capture outcome with the injected row count, the last provider failures, store problems and
duplicate `category` + `setting` pairs across providers — so a missing row is an answer, not
a silent no-op. Duplicates are computed from the rows the last menu build actually
received, so before any build the report says `duplicate settings: no build yet` instead of
claiming there are none. Diagnostics never run a provider's `rows()`.

It also answers the sidebar question: a `sections` table (id, title, persisted visibility and
where the position comes from), the most recent frame's `section failures`, and a `sidebar`
line — `intercepted (rail wrapped)`, `intercepted (rail pending)`, `no-sidebar-state`, or
`not armed` with the reason the wiring could not acquire a `tui`. Those three blocks appear
only when they have something to say, so a row-only install keeps the historical output.
Diagnostics never run a section's `lines()`/`meta()` either. The hook backend is reported as
`hook` only when this process pushed its fan-out provider into a host registry.

For card styles it reports the line mode (`extended` when the host's own line was found,
`separate` when the fallback line was used), the registered styles in order, the live selection
(including a disposed one, as `missing`), what the last frame did (`transformed N cards`,
`pass-through (native | missing | no card)`, or `failed` with the style and message), the per-style
failures, whether the conversation component was wrapped, and the reminder that a downstream
post-processor can override the frame.

## Limits

- **No new categories.** gentle-shell's renderer types `category` as a closed union
  (`Animations | Banner | Themes | Editor | History | Notifications | Layout | Cards |
  Sections | Keymaps | Profiles | Reset`, `lib/visual-customize-view.ts:105`). The bridge's
  own `CustomizeRow.category` is a `string`, and it cannot create a category the renderer
  does not know, so pass one that already exists — `Cards`, `Banner`, `Layout` and so on.
- **No upstream hook exists.** The bridge depends on gentle-shell internals; the day
  gentle-shell changes its menu construction, the fix is in one place, but it is still a
  fix against internals rather than a supported extension point.
- **The capture backend patches `Array.prototype.map`** for the duration of one
  synchronous factory call. It is restored in a `finally` block, it never survives the
  call, and it is only installed inside the customize-menu path.
- **The capture is heuristic.** It recognises the row array by shape; a menu that builds
  its rows differently produces no capture. That case is reported by `/bridge-status` instead of
  passing silently.
- **Card styles are a repaint, not a host feature.** The bridge rewrites the `float` frames
  gentle-shell already drew, so it depends on that grammar, and a downstream post-processor
  (cinlodev strips box chrome from the cards it re-frames) can override the result — the bridge
  says so in `/bridge-status` instead of pretending otherwise. Detection is proven against a fake
  conversation built from real `shell-card.ts` output, never in a running TUI, and a card with a
  blank body row is detected as ending at that row.
- **Tests cover a fake host, not the real TUI.** 328 tests run under `node --test`; 26 of
  them are end-to-end through the public API and the extension entry, against a fake host
  that models `gentle-shell.ts:3550-3562` and a fake sidebar that models
  `lib/shell-sidebar.ts` and the layout's card frame. The capture technique is verified in the
  real TUI only by the reference probe, and the hook backend has never run against a real host.
- **The sidebar has never been seen in a running TUI.** The rail interception, the section
  cards and the automatic `Sections` rows are proven against the fake rail. In particular,
  whether the widget Pi hands the `tui` through leaves the editor area visually untouched is
  **unconfirmed** — the component renders no rows, which is the minimal guess.
- **Sections render after the native cards, never between them.** The host's status sections
  are built in a closure, so interleaving is not offered.
- **The sidebar needs `ctx.ui.setWidget`.** Pi exposes no `tui` getter; without the widget
  factory the rail cannot be reached, and `/bridge-status` reports `sidebar: not armed` with
  the reason while the `Sections` toggle keeps working.
