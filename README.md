# gentle-shell-bridge

A shared, plugin-facing bridge between Pi plugins and gentle-shell's `/gentle:customize`
menu. A plugin publishes a *row provider*; the bridge owns the single interception layer
and fans out to every provider, so N plugins × M gentle-shell surfaces becomes N providers
and one interception. Plugins stop wrapping `ctx.ui` themselves, and stop colliding with
each other when more than one wants to add a settings row.

**Status: released as `0.3.0`.** The package exists and runs. It is a manifest-backed Pi
package (`pi.extensions` → `./src/extension.ts`) loaded from TypeScript sources through
jiti, so there is no build step and no `dist/`; it registers a `bridge-status` command and
carries a `node --test` suite of 422 tests, 26 of them end-to-end through the public API and
the real extension entry, 8 driving the worked example's transform through a real
conversation wrapper, and 22 pinning the publication announcement in both load orders. The capture
technique was proven in the real TUI by a 76-line
throwaway extension (`loon-customize-probe.ts`); the capture backend implements it, while
the hook backend is implemented but **unverified** — no host has been observed emitting the
registry it looks for. The sidebar surface is proven against a fake rail, not in a live TUI:
what is not proven is listed under **Limits**.

- [PRD.md](PRD.md) — problem, users, requirements, success criteria
- [docs/architecture.md](docs/architecture.md) — how the host menu is reached, with source citations
- [docs/contract.md](docs/contract.md) — `registerRows`, provider and row shapes, diagnostics
- [docs/state.md](docs/state.md) — ADR: stateless composition plus optional per-plugin store

## Worked consumer

[`examples/bash-card.ts`](examples/bash-card.ts) is a standalone Pi extension that covers every
surface the package publishes: a `Cards` toggle through `registerRows` + `createStore`; a **`BASH CARD`
sidebar section** through `registerSection`, toggled from **`Sections`** in `/gentle:customize` with
no setting, row or store written by the plugin; a third card style through
`registerCardStyle`, which puts `plain` next to the host's own values on the `Card style` line —
`○ neon ○ float ○ plain`; and a transcript transform through `registerTransform`, which is what makes
the `Bash rendering` toggle apply to the bash cards **already on screen**.

The toggle is the single control. `default` leaves the host's bash card exactly as the host drew it;
`tool` rewrites every bash card in the frame with the example's own chrome (`▸ bash`, its body, `▸`),
whether it was drawn before the switch or after it. That is the difference between a transform and
`pi.registerToolRenderer`: the renderer resolves once, when a tool row is BUILT, so it could only ever
restyle the next card; a transform runs on every frame the conversation component renders. The
example registers no tool renderer at all — one owner, one look, past and new byte-identical.

`plain` is a style for TOOL cards in general: selecting it repaints a `read` card exactly like a
`bash` one, so one style applies across tools. Choosing `neon` or `float` returns to the host's
rendering, because those values ARE the host rendering. The style and the transform are registered
from the same guarded call as the other surfaces, through the API object, and only when
the published object actually carries them — an older bridge keeps what it can and the example says
nothing about a surface the bridge never promised.

Copy the file into `~/.pi/agent/extensions/` and `/reload` to load it; the toggle defaults to
`default`, so installing it changes no bash rendering until the row is switched, while the section
is visible immediately (`defaultVisible: true`). It does not import the package and does not know
where it is installed: the example and the bridge meet on `globalThis` behind one symbol (see
**Reaching the bridge without importing it**). Global extensions load before configured packages,
so the example does not assume the bridge got there first: it tries the symbol in its own
`session_start` handler **and** listens for the bridge's `gentle-shell-bridge:ready` announcement,
whichever comes first registering the same four surfaces (registration replaces by stable id, so
the second one adds nothing). When neither has happened yet, the notice says which state the load
is in — waiting for an announcement on a Pi with an event bus, or nothing to wait for on one
without — instead of claiming the bridge is not installed.

Both rows carry `preview()`, so `/gentle:customize` draws a literal sample of the card each
mode produces instead of "Preview unavailable".

A bridge that publishes something else — another major version, a partial object, another library's
payload at the symbol — is treated as absent, never as an error: the example never calls an object it
cannot trust, registers nothing, and says so once through `ctx.ui.notify` (naming the announcement
channel when this Pi has one, because then a later publication is still possible). The bridge reports
the version skew once per process.

## Install

The package is `0.3.0`. Load it from source as a Pi extension package alongside gentle-shell
and Pi discovers `src/extension.ts` through the `pi` manifest. The shipped files are the
TypeScript sources: Pi loads them through jiti, so there is no build step and no `dist/` to
publish.

For a plugin that imports the API, `exports` maps the package root to `src/index.ts`:

```ts
import {
  BRIDGE_READY_EVENT,
  bridgeApi,
  createStore,
  isBridgeApi,
  onBridgeApi,
  registerCardStyle,
  registerRows,
  registerSection,
  registerTransform,
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
handler — or, if your plugin may load before this package, through `onBridgeApi(handler, pi.events)`,
which answers in both orders.

The second surface needs no `Sections` row, no setting name and no store of its own — one call
adds the card to the sidebar and its show/hide toggle to `/gentle:customize` → `Sections`.

```ts
import { registerSection } from "gentle-shell-bridge";

const dispose = registerSection({
  id: "loon.music",             // unique and stable: ordering, replacement, the toggle; internal
  title: "MUSIC",               // card heading, framed by the host like AGENTS / STATS
  rowLabel: "music",            // optional: the text the Sections row reads (derived from title)
  meta: () => "1 playing",      // optional right-aligned count
  lines: () => ["track  Blue in Green", "album  Kind of Blue"], // per frame, live
  defaultVisible: true,
  order: 10,                    // optional; unordered sections follow, in registration order
});

// dispose() removes the card and its toggle; other sections are untouched.
```

The row is a **label**, never the id and never a prefix. The host's own `Sections` rows read
`changes`, `stats`, `usageCost`; a plugin's section reads the same way:

```text
stats             ● shown  ○ hidden     ← the host's own row
music             ● shown  ○ hidden     ← this plugin's section
```

`id` stays internal: it is the replacement, disposer and stored-visibility key, and it never
appears in a row. With no `rowLabel`, the bridge derives one from `title` — lowercase words joined
by spaces, dots and punctuation dropped, at most three words (`"BASH CARD"` → `"bash card"`,
`"MUSIC PLAYER NOW PLAYING"` → `"music player now"`). Two sections whose labels would read the same
are told apart deterministically (`music`, `music 2`, …) and `/bridge-status` says which one moved;
the raw id is never the suffix. An explicit `rowLabel` obeys the same row-name shape described under
"Row names" below — a name that breaks it is rejected and reported, never rewritten.

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

A plugin can add a third card style to gentle-shell's cards, on the host's own `Card style` line,
without touching the host. The bridge owns detection; the style owns drawing. A style is one global
choice, so it paints every card surface the host frames — the **conversation** and the fullscreen
**rail** (host sections like `CHANGES` and contributed sections alike) — and `native` restores the
host's own frames on both. The rail is covered by the same `transformCardLines` the conversation
uses, so a plugin registers nothing extra for it.

```ts
import { registerCardStyle } from "gentle-shell-bridge";

const dispose: () => void = registerCardStyle({
  id: "loon.cute",  // unique; the stored value and the replacement key — internal, never a row
  label: "cute",    // the line's value: Card style  ○ neon ● float ○ cute
  rowLabel: "cute", // optional: what this style's row reads (derived from label when absent)
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
`neon`/`float` and the bridge's `native` are taken), the visible text is a label (`label` on the
line, `rowLabel` — or `label` made readable — for the row), the id never appears in a row, and the
style only ever receives text and a width — it parses nothing. Full contract: [docs/contract.md](docs/contract.md) §12.

## Quick start: a transcript transform

A tool renderer resolves once, when a row is built. A transform runs on every frame the conversation
component renders, which is the only way a rendering choice can reach rows that were already drawn.

```ts
declare const registerTransform: (transform: {
  id: string;
  order?: number;
  transform(lines: readonly string[], ctx: { width: number }): readonly string[];
}) => () => void;

const dispose = registerTransform({
  id: "loon.gutter",   // unique: the ordering/replacement key and the /bridge-status name
  order: 10,           // optional: ordered transforms run first, ascending
  transform: (lines, ctx) => lines.map((line) => line.slice(0, ctx.width)),
});

// The user sees the new rendering on the NEXT FRAME, for every row — including cards drawn before
// the choice was made. dispose() removes this transform; other plugins' transforms keep running.
```

The pipeline is what the bridge's existing conversation wrapper runs after the card-style repaint:
`lines` is the previous transform's output, and the first transform sees the card-style repaint of
the host's own rows. What the bridge guarantees, and what the contract is:

- what a transform returns is **clipped to `ctx.width`** (the width the host rendered at), so a
transform can never make the frame wider than the terminal;
- a transform that **throws**, or returns anything that is not an array of strings, loses only its
own contribution for that frame; the lines in force are kept and the remaining transforms still run;
- a transform that returns its input **unchanged** is recorded as `skipped` and the frame keeps its
identity — with no transform registered, the wrapper returns the host's own array instance.

`/bridge-status` lists the pipeline in order with the last frame's outcome per transform. Full
contract: [docs/contract.md](docs/contract.md) §13.

## Reaching the bridge without importing it

A plugin and the bridge are two independent projects, so a path to one checkout is not a contract.
They meet on `globalThis`, behind one stable symbol:

- `Symbol.for("gentle-shell-bridge/api/v1")` holds
  `{ schema: "gentle-shell-bridge/api", version: 1, VERSION, registerRows, registerSection, registerCardStyle, registerTransform, createStore }`.
  It is frozen, first-wins (a valid object already there is kept, not replaced) and never reset.

**Register at `session_start` if the package loaded first, otherwise when it announces itself.**
The symbol is the authority; the announcement is the timing. Pi does not guarantee that this
package loaded before your plugin: global extensions (`~/.pi/agent/extensions`) load, and receive
`session_start`, before a configured package's module publishes — observed in a real TUI, where the
worked example said "no compatible bridge" while a bridge was about to appear. So a plugin loaded
early listens for one event:

```ts
pi.events?.on("gentle-shell-bridge:ready", ({ schema, version, VERSION }) => {
  // the object is published now: read the symbol again and register
});
```

The bridge emits it **once per process**, after a successful publish, and never when the slot holds
an incompatible payload. It carries identity only — `{ schema, version, VERSION }` — because it is a
notification, not a registry: the listener reads the symbol and applies the same gate. A Pi without
`pi.events` emits nothing, and the symbol still works for anyone who reads it.

Inline the gate (the example does), or import the package and let `onBridgeApi` handle both forms —
handler called immediately when the object is already there, subscribed when it is not, detached
after one delivery:

```ts
const KEY = Symbol.for("gentle-shell-bridge/api/v1");
const isApi = (v: any) => typeof v === "object" && v !== null && v.schema === "gentle-shell-bridge/api" &&
  v.version === 1 && typeof v.registerRows === "function" &&
  typeof v.registerSection === "function" && typeof v.createStore === "function";

const register = (): boolean => {
  const api = (globalThis as any)[KEY];
  if (!isApi(api)) return false;
  api.registerSection({ id: "loon.music", title: "MUSIC", lines: () => ["…"] });
  return true;
};

if (!register()) pi.events?.on("gentle-shell-bridge:ready", register);

pi.on("session_start", (_event, ctx) => {
  if (!register()) {
    ctx.ui?.notify("my-plugin: waiting for gentle-shell-bridge to announce itself", "warning");
  }
});
```

A plugin that imports the package gets both forms in one call — the handler runs immediately when
the object is published and when the announcement arrives otherwise, and the subscription detaches
itself after one delivery:

```ts
import { onBridgeApi } from "gentle-shell-bridge";

const dispose = onBridgeApi((api) => {
  api.registerRows({ id: "loon.banner-source", category: "Cards", rows: () => [] });
}, pi.events); // works in both load orders; `bridgeApi()` alone does not wait
```

Rules worth knowing: an object that fails the gate (wrong schema, `version !== 1`, a missing member)
is **absent**, never an error — `bridgeApi()` returns `undefined`, one warning is emitted per
process, and the slot is left exactly as it was. A breaking change takes a new `v2` symbol key
rather than mutating `v1`. An older bridge publishes nothing at this key, so a newer plugin sees
"absent" instead of being deferred silently; that compatibility cliff is intentional. The full rule
and complete snippets are in [docs/contract.md](docs/contract.md) §9, with the surfaces documented in
§9 (rows, sections, store), §12 (card styles) and §13 (transcript transforms).

## Quick start: rows

```ts
import { createStore, registerRows } from "gentle-shell-bridge";

const store = createStore("loon"); // ~/.pi/gentle-ai/gentle-shell-bridge/loon.json
const read = () => store.get("bannerSource", "activity");

const toggle = (value: string) => ({
  category: "Banner" as const,
  label: () => "Loon banner source",
  choice: { setting: "Loon banner source", value, current: () => read() === value },
  action: () => store.set("bannerSource", value), // persist first; the menu re-renders
});

const dispose = registerRows({
  id: "loon.banner-source",
  category: "Banner",
  rows: () => [toggle("activity"), toggle("output")], // consecutive, same setting → one line
});

// dispose() removes every row this provider contributed; other providers are untouched.
```

### Row names

`choice.setting` (the line's name) and `label` (the row's text) are read by a human, so both obey one
shape: **one to three plain words**, title case like the host's own `Card style` / `Card content`,
and **none of** `→ ← ↑ ↓ : . | / \ [ ] ( ) { }`. No trailing qualifier — the category says where the
row lives and the values say what the choices are:

```text
Bash rendering                  OK    a row name, in the host's own vocabulary
Bash card → Bash rendering      BAD   an arrow and a repeated qualifier: reads as a breadcrumb
Bash card: rendering            BAD   a colon
Section: bash-card.status       BAD   a prefix plus a dotted internal id
```

The bridge enforces this rather than trusting authors, and it never rewrites a name it refused:

- a provider row whose line name or label breaks the shape is dropped from the menu build, so it
  reaches neither the host's rows nor the rows `/bridge-status` compares;
- a section or a card style whose `rowLabel` breaks it is not registered at all;
- the offending string and the rule it broke are recorded verbatim and listed by `/bridge-status`
  under `row name rejections`.

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
duplicate `category` + `setting` pairs across providers, and any row name the shape rule rejected —
the surface, the registration id, the offending string verbatim and the rule it broke, under
`row name rejections` — so a missing row is an answer, not a silent no-op. Duplicates are computed
from the rows the last menu build actually received, so before any build the report says
`duplicate settings: no build yet` instead of claiming there are none. Diagnostics never run a
provider's `rows()`.

It also answers the sidebar question: a `sections` table (id, title, the `row` label the menu
reads plus a collision note when two labels wanted the same text, persisted visibility and where
the position comes from), the most recent frame's `section failures`, and a `sidebar` line —
`intercepted (rail wrapped)`, `intercepted (rail pending)`, `no-sidebar-state`, or
`not armed` with the reason the wiring could not acquire a `tui`. Those three blocks appear
only when they have something to say, so a row-only install keeps the historical output.
Diagnostics never run a section's `lines()`/`meta()` either. The hook backend is reported as
`hook` only when this process pushed its fan-out provider into a host registry. Ids stay in this
report on purpose: it is for the plugin author diagnosing a registration, not for the user picking
a toggle.

For card styles it reports the line mode (`extended` when the host's own line was found,
`separate` when the fallback line was used), the registered styles in order, the live selection
(including a disposed one, as `missing`), what the last frame did (`transformed N cards`,
`pass-through (native | missing | no card)`, or `failed` with the style and message), the per-style
failures, whether the conversation component was wrapped, and the reminder that a downstream
post-processor can override the frame. Per surface it also says whether the style reached it and what
its last frame did there (`card style surface rail: reached (rail wrapped), last frame transformed 3
cards`, or `not reached (no-layout-root)`), and it reports the last repaint a bridge-owned write
requested — `last repaint: rail for section "loon.music" → hidden (repainted)` — including the reason
when no frame could be asked for. A visibility toggle and a card-style selection repaint
synchronously, before the action returns; nothing polls.

For transcript transforms it reports the registered pipeline in order — `order 10` or `registration
order` — and what the last frame did with each one: `applied`, `skipped`, `failed` with the message,
or `not run` for a transform registered after that frame. The block appears only when a transform is
registered, so a session that never used the pipeline keeps the historical report byte for byte.

The bridge also sets **one INTEGRATIONS row per plugin** in Pi's footer, through
`ctx.ui.setStatus(key, text)`, and reports it as a per-plugin list: the name and whether it was
`derived from package "@acme/loon-kit"` or an `explicit name`, the registrations `accepted` and
`rejected`, and whether the row is set — or `no line set` with the reason. The header says when the
host's `setStatus` is unavailable at all. The rules that line obeys:

- **The row text is opaque.** The host renders the whole string as one row, so everything the row
  says is inside it: `Loon kit · ready`. Its `sanitizeStatus` strips ANSI and collapses whitespace,
  so **ANSI is not available** to a plugin, and any glyph must be part of the text
  (`🧠 gentle-pi · ready` is the host's own fixture).
- **Colour belongs to the host.** Every entry is painted with one shared role; a plugin chooses a
  glyph, never a colour.
- **One plugin means one line.** Ten rows, three sections, a card style and a transform still paint
  one row; later changes repaint the same key in place, and `session_shutdown` clears it with
  `undefined`.
- **The name is derived, or given once.** The bridge resolves the module that registered to its
  owning `package.json` and derives one to three plain words (`@acme/loon-kit` → `Loon kit`); an
  optional `name` on the plugin's first registration overrides it. A single copied file with no
  owning package gets **no row** (fail closed, the reason is in `/bridge-status`) unless it passes
  that `name`. A rejected name is never shown.
- **`ready` is derived, never promised.** One rejected registration — an invalid id, a row label that
  broke the shape rule — makes the same key read `degraded`, and the report names the rejected
  items.

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
  gentle-shell already drew, so it depends on that grammar, and a downstream post-processor that
  re-frames the conversation and strips box chrome can override the result — the bridge
  says so in `/bridge-status` instead of pretending otherwise. Detection is proven against a fake
  conversation built from real `shell-card.ts` output, never in a running TUI, and a card with a
  blank body row is detected as ending at that row.
- **A transform is a per-frame pass, not a host feature either.** It runs inside the wrapper the
  bridge already installs on the conversation component, so it depends on the same Pi tree the card
  styles do, and a downstream post-processor can still override the frame. A transform sees lines,
  not tool metadata: a plugin that needs the call's arguments or the result object still has to use
  `pi.registerToolRenderer` for rows that are yet to be built. A throwing transform is isolated per
  frame; a slow one runs on every frame, which the bridge cannot bound.
- **Tests cover a fake host, not the real TUI.** 422 tests run under `node --test`; 26 of
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
