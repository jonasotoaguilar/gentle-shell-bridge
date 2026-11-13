# gentle-shell-bridge

A shared, plugin-facing bridge between Pi plugins and gentle-shell's `/gentle:customize`
menu. A plugin publishes a *row provider*; the bridge owns the single interception layer
and fans out to every provider, so N plugins × M gentle-shell surfaces becomes N providers
and one interception. Plugins stop wrapping `ctx.ui` themselves, and stop colliding with
each other when more than one wants to add a settings row.

**Status: pre-release (`0.0.0`).** The package exists and runs. It is a manifest-backed Pi
package (`pi.extensions` → `./src/extension.ts`) loaded from TypeScript sources through
jiti, so there is no build step and no `dist/`; it registers a `bridge-status` command and
carries a `node --test` suite of 96 tests, 10 of them end-to-end through the public API and
the real extension entry. The capture technique was proven in the real TUI by a 76-line
throwaway extension (`loon-customize-probe.ts`); the capture backend implements it, while
the hook backend is implemented but **unverified** — no host has been observed emitting the
registry it looks for. Every runtime claim below was either observed in that TUI run or
read from the cited host source; what is not proven is listed under **Limits**.

- [PRD.md](PRD.md) — problem, users, requirements, success criteria
- [docs/architecture.md](docs/architecture.md) — how the host menu is reached, with source citations
- [docs/contract.md](docs/contract.md) — `registerRows`, provider and row shapes, diagnostics
- [docs/state.md](docs/state.md) — ADR: stateless composition plus optional per-plugin store

## Install

The package has no release yet (`version` is `0.0.0`); load it from source as a Pi
extension package alongside gentle-shell and Pi discovers `src/extension.ts` through the
`pi` manifest. The shipped files are the TypeScript sources: Pi loads them through jiti, so
there is no build step and no `dist/` to publish.

For a plugin that imports the API, `exports` maps the package root to `src/index.ts`:

```ts
import { createStore, registerRows, STORE_SCHEMA_VERSION, VERSION } from "gentle-shell-bridge";
```

`engines.node` is `>=22.18.0` because the test suite runs `.ts` files directly through
Node's native type stripping, with no transpile step.

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

The bridge registers one command, `/bridge-status`. It reports the registered providers (id
and category, in subscription order), the active backend (`hook` or `capture`), the last
capture outcome with the injected row count, the last provider failures, store problems and
duplicate `category` + `setting` pairs across providers — so a missing row is an answer, not
a silent no-op. The hook backend is reported as `hook` only when this process pushed its
fan-out provider into a host registry.

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
- **Tests cover a fake host, not the real TUI.** 96 tests run under `node --test`; 10 of
  them are end-to-end through the public API and the extension entry, against a fake host
  that models `gentle-shell.ts:3550-3562`. The capture technique is verified in the real TUI
  only by the reference probe, and the hook backend has never run against a real host.
