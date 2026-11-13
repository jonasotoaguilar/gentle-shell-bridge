# gentle-shell-bridge

A shared, plugin-facing bridge between Pi plugins and gentle-shell's `/gentle:customize`
menu. A plugin publishes a *row provider*; the bridge owns the single interception layer
and fans out to every provider, so N plugins × M gentle-shell surfaces becomes N providers
and one interception. Plugins stop wrapping `ctx.ui` themselves, and stop colliding with
each other when more than one wants to add a settings row.

**Status: early / pre-release.** The package is the extraction of a verified probe: a
76-line throwaway extension (`loon-customize-probe.ts`) proved the capture technique in
the real TUI. There is no `package.json`, no build and no published artifact yet. Every
runtime claim below was either observed in that TUI run or read from the cited host
source; unproven behaviour is listed under **Limits**.

- [PRD.md](PRD.md) — problem, users, requirements, success criteria
- [docs/architecture.md](docs/architecture.md) — how the host menu is reached, with source citations
- [docs/contract.md](docs/contract.md) — `registerRows`, provider and row shapes, diagnostics
- [docs/state.md](docs/state.md) — ADR: stateless composition plus optional per-plugin store

## Install

Nothing to install yet. This repository contains documentation only: no package manifest,
no build output, no published tarball. When the extraction lands it will be installed as a
Pi extension package alongside gentle-shell; the API documented here is the API the probe
proves is reachable.

## Quick start

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

The bridge registers one `status` command. It reports the registered providers (id and
category, in subscription order), the active backend, the last capture outcome, and the
last provider failures — so a missing row is an answer, not a silent no-op.

## Limits

- **No new categories.** `CustomizeRow.category` is typed to gentle-shell's closed union
  (`Animations | Banner | Themes | Editor | History | Notifications | Layout | Cards |
  Sections | Keymaps | Profiles | Reset`), so the bridge adds rows to existing categories
  such as `Cards`, `Banner` and `Layout` only. A novel category string is outside the type
  and unverified at runtime.
- **No upstream hook exists.** The bridge depends on gentle-shell internals; the day
  gentle-shell changes its menu construction, the fix is in one place, but it is still a
  fix against internals rather than a supported extension point.
- **The capture backend patches `Array.prototype.map`** for the duration of one
  synchronous factory call. It is restored in a `finally` block, it never survives the
  call, and it is only installed inside the customize-menu path.
- **The capture is heuristic.** It recognises the row array by shape; a menu that builds
  its rows differently produces no capture. That case is reported by `status` instead of
  passing silently.
- **No automated test suite yet.** The current evidence is one manual TUI run of the probe.
