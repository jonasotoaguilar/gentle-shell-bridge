# ADR 0001 — Stateless composition, with an optional per-plugin store

- **Status:** accepted for the extraction; implemented in `src/store.ts` and exercised by the
  test suite. **Amended** by decision 4: a registered sidebar section's visibility is the one
  piece of state the bridge itself owns.
- **Context:** [contract.md](contract.md), [architecture.md](architecture.md)
- **Deciders:** package author and gentle-shell maintainers.

## Context

The bridge exists to compose rows from many plugins into one menu. A row's `●` is computed
by `current()`, which the renderer calls at render time (`lib/visual-customize-view.ts:585`),
and a toggle applies through `action()`, which the view runs on ←/→ or Enter
(`lib/visual-customize-view.ts:565`) and follows with its own repaint
(`lib/visual-customize-view.ts:579`). Persistence therefore has to sit behind the row, and
the question is *who owns it*: the bridge, each plugin, or nobody.

Two practical constraints shape the answer:

1. Row state must outlive `/reload` to be useful, and Pi gives each extension its own copy
   of any imported module (`lib/shell-card.ts:30-32`), so in-memory module state is
   per-extension and per-load.
2. Plugins already have their own config files in gentle-shell, written atomically
   (gentle-shell uses temp-file plus `renameSync`, e.g. `lib/agent-profiles.ts:715`,
   `lib/animation-policy.ts:47`). A bridge that owns state would need to replicate that
   discipline for data it does not understand.

## Decision

**1. The bridge is stateless by default.** It composes rows; it does not own preferences,
caches no row values, and has no opinion about a plugin's config format. Diagnostics hold
runtime facts (registrations, capture outcome, failures), not settings.

**2. The bridge also exposes an optional `createStore(pluginId)`.** A plugin that wants
zero boilerplate gets:

- path: `<gentle config home>/gentle-shell-bridge/<pluginId>.json` — namespaced by plugin,
  under the directory gentle-shell already resolves (default `~/.pi/gentle-ai`,
  `GENTLE_PI_CONFIG_HOME` override — `lib/gentle-shell-bundled.ts:231-239`);
- atomic writes: write a temporary file in the same directory, then rename over the
  target, so a crash mid-write cannot truncate the live file;
- a schema version field (integer `schemaVersion`, currently `1`) so a future shape change
  can migrate instead of guessing;
- a document shape of `{ "schemaVersion": 1, "values": { … } }`, decided during
  implementation: the `values` envelope keeps a plugin key from ever colliding with
  `schemaVersion`;
- `pluginId` validation before any filesystem access: one non-empty path segment, no
  separators, no `.` or `..`, and a resolved path that cannot leave
  `<config home>/gentle-shell-bridge`;
- read/write accessors (`get(key, fallback)`, `set(key, value)`) scoped to that one file.

**3. A plugin may keep using its own file** — gentle-shell plugins do this today, e.g.
`loon-tui.json`. The bridge never reads or writes a plugin's own file. `createStore` is a
convenience for plugins that have no file yet, not a migration target for plugins that do.

**4. One exception, and only one: a sidebar section's visibility is bridge-owned state.**
`registerSection` makes the bridge create the show/hide toggle, so the value behind that toggle
cannot belong to the plugin: there is no plugin row, no plugin-chosen setting name and no plugin
store in the flow. The bridge persists it in its own namespaced file,
`<gentle config home>/gentle-shell-bridge/bridge-sections.json`, as

```json
{ "schemaVersion": 1, "values": { "sections": { "loon.music": false } } }
```

one key (`sections`) mapping section id → boolean, defaults taken from the section's
`defaultVisible`, non-boolean values ignored rather than coerced.

Why not the host's `visual-customization.json`: gentle-shell validates that file against a closed
`VISUAL_SECTION_KEYS` list (`lib/visual-customization-policy.ts:82`, `keysMatch` ~:112-130) and
rejects unknown keys, so a third-party section key cannot live there. The user experience is the
native one; the file deliberately is not, and that difference is documented in
[contract.md](contract.md) §10 rather than hidden.

## Consequences

### The correctness rule

`current()` must read the plugin's live state at render time, and `action()` must persist
first and re-render second. Concretely: `action()` writes through `createStore` (or its own
file) and returns; the view's own repaint re-evaluates `current()`, which reads the same
store, so `●` lands on the value that was just written. Inverting the order — paint, then
persist — makes the bullet lie for one frame and, on a failed write, permanently.

```ts
choice: { setting: "Loon → Banner source", value, current: () => read() === value },
action: () => store.set("bannerSource", value), // persist; repaint follows
```

The bridge cannot enforce this. It can only document the rule; a plugin that caches a value
at registration produces a stale `●` and the diagnostics command will not detect it.

### Bridge-owned section visibility

This is the one place the bridge is not stateless, and the reason is structural: the bridge
generates the toggle, so only the bridge can know which value it points at. The plugin still owns
nothing — it never sees this file, never picks a key, and its section appears or disappears from
the same user gesture as a native one.

- The blast radius stays per surface: one corrupt `bridge-sections.json` disables section
  visibility only. It reads as empty (defaults apply), is reported by `/bridge-status` as a store
  problem, and is rewritten as a valid document by the next toggle — the same rules
  `createStore` already follows for plugin files.
- A plugin that also keeps its own state is unaffected: this file is keyed by section id and the
  bridge never reads anything else from it.
- The cost is honest: the bridge now owns one preference. It is a preference about the bridge's
  own surface, which is why it belongs here and not in a plugin's namespace.

### Reads, cost and limits of bridge-owned visibility

- Visibility is read once per frame by the renderer and once per `current()` call by the rows, so a
  toggle shows up on the sidebar's next frame (pinned by a test), at the cost of a small file read
  per read. A cache would need to be invalidated by the toggle's own write.
- There is no migration path from a future `visual-customization.json` section key; if the host ever
  opens `VISUAL_SECTION_KEYS`, this file becomes redundant and can be migrated in one place.

### Other consequences

- One plugin's corrupt or slow file cannot affect another plugin's rows or the menu.
- Two plugins writing concurrently never touch the same file, so there is no cross-plugin
  write contention and no cross-plugin lock protocol to design.
- Duplicate work is accepted: N plugins may each implement a small atomic-write helper.
  The alternative was N plugins contending on one file owned by the bridge.
- A malformed store file is reported through `/bridge-status` and reads fall back to the
  plugin's defaults; the bridge does not repair or delete the file, and a later `set` writes
  a valid document. Existing `values` are carried into that write **only** when the file was
  a usable `schemaVersion: 1` document (so a partially written file keeps its other keys).
  For an unknown `schemaVersion` the write stores only the keys the caller set and records
  the discarded payload as a store problem: the bridge cannot know what a future schema's
  payload means, so re-labelling it as schema 1 would be a lie about its format, and
  silently destroying it while pretending it is valid would be worse than reporting it.
  Foreign top-level keys are always dropped. A reported problem stays on record until a
  write resolves it, so reading the repaired file cannot erase it from `/bridge-status`.
- A plugin that keeps its own file gets no migration help from the bridge — this is the
  documented cost of the opt-in helper.
- The bridge acquires disk-write code it must test, and it does test it (round-trip,
  malformed file, atomicity, path rejection on temporary directories); if `createStore`
  proves to add more risk than boilerplate it removes, it can be dropped without changing
  `registerRows`.

## Alternatives rejected

**A. Bridge centralises all state in one JSON file.** One file under the gentle config home
holding every plugin's settings. Rejected: a corrupt or truncated file breaks every plugin
at once, and concurrent writers from independent plugins contend on the same file — the
exact cross-plugin coupling the bridge exists to remove. It also forces the bridge to
understand, validate and migrate data from plugins it does not control.

**B. Bridge writes nothing and offers no helper.** Maximum separation: composition only.
Rejected: every plugin re-implements atomic writes, namespace paths and version fields, and
there is no shared migration story — a plugin that gets it wrong loses user settings, and
there is no single place to fix the pattern. The duplication is real and predictable, which
is why the optional helper wins over pure minimalism.

**C. Chosen: stateless composition plus optional namespaced store.** Keeps the blast radius
per plugin (A's failure mode), keeps a fixable default for the write path (B's gap), and
leaves existing plugin files untouched.

## Open questions

- Should `createStore` ship at all in the first release, or follow once a second plugin
  needs it? — **Settled during implementation: it ships.** Deferring would have been
  compatible with this decision; nothing in `registerRows` depends on the store.
- Whether migrations beyond `schemaVersion: 1` belong in the bridge or in the plugin.
- Whether a plugin that keeps its own file should be able to *declare* that path to
  `/bridge-status` for diagnostics only. No read, no write — purely visibility.

## Limits

- No file locking is specified: atomic rename prevents torn writes, not lost updates from
  two processes editing the same plugin file. A plugin that runs in parallel sessions must
  accept last-writer-wins or guard its own writes.
- `createStore` is implemented and tested against temporary directories, including the
  malformed-file path; it has not been exercised inside a running Pi session, and it has no
  cross-process locking (see the first limit).
- Secrets do not belong in these files; the store provides no redaction.
