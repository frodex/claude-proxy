# Impact Report: YAML-Driven Form Configuration

**Date:** 2026-03-31
**Question:** How hard is it to parameterize the session form via YAML?

---

## Verdict: Low difficulty, high leverage

The project already uses YAML (`yaml@2.8.3`) with a config loader (`src/config.ts`) and layered merging. The pattern exists — we're extending it, not inventing it.

---

## What moves from code to config

Today, `buildCreateSessionSteps()` (index.ts:135-265) hardcodes 11 fields. Each field has four concerns:

| Concern | Currently | With YAML |
|---------|-----------|-----------|
| **Which fields exist** | Hardcoded array of FlowStep objects | YAML field list with IDs |
| **Per-mode behavior** (locked/hidden/prefill) | Doesn't exist — only one mode (create) | YAML matrix: `modes.edit.name: { locked: false, prefill: true }` |
| **Conditions** (admin-only, hidden→skip) | Inline functions: `() => isAdmin(client.username)` | YAML: `condition: admin-only` or `condition: not-hidden` mapped to named predicates |
| **Widget creation** | Inline: `new TextInput({ prompt: '...' })` | Stays in code — widgets need runtime context (user lists, dir scans) |

**Key insight:** Widget creation and `onResult` callbacks stay in code. They need runtime data (user lists, group lists, directory scans, config.remotes). What moves to YAML is the *metadata* — field ordering, labels, which modes show/lock/hide each field, required vs optional, default values for simple types.

---

## Proposed YAML shape

```yaml
# In claude-proxy.yaml or a separate session-form.yaml
session_form:
  fields:
    - id: name
      label: Session name
      widget: text
      required: true
      modes:
        create: { visible: true, locked: false }
        edit:   { visible: true, locked: false, prefill: true }
        restart: { visible: true, locked: false, prefill: true }
        fork:   { visible: true, locked: false, prefill: fork-name }

    - id: runas
      label: Run as user
      widget: text
      condition: admin-only
      modes:
        create:  { visible: true, locked: false }
        edit:    { visible: true, locked: false, prefill: true }
        restart: { visible: true, locked: false, prefill: true }
        fork:    { visible: true, locked: true, prefill: true }

    - id: server
      label: Server
      widget: list
      condition: admin-with-remotes
      modes:
        create:  { visible: true, locked: false }
        edit:    { visible: true, locked: true, prefill: true }
        restart: { visible: true, locked: true, prefill: true }
        fork:    { visible: true, locked: true, prefill: true }

    - id: workdir
      label: Working directory
      widget: combo
      modes:
        create:  { visible: true, locked: false }
        edit:    { visible: true, locked: true, prefill: true }
        restart: { visible: true, locked: true, prefill: true }
        fork:    { visible: true, locked: true, prefill: true }

    # ... remaining 8 fields follow same pattern
```

---

## Implementation effort

### New code needed

| Component | Effort | Lines (est.) |
|-----------|--------|-------------|
| **Type definition** for YAML schema | Trivial | ~30 |
| **Loader** — parse YAML, validate, merge with defaults | Small | ~50 |
| **Predicate registry** — named conditions (`admin-only`, `not-hidden`, `admin-with-remotes`) mapped to functions | Small | ~25 |
| **Widget factory** — `widget: text` → `new TextInput(...)` with runtime context | Medium | ~60 |
| **buildSessionFormSteps() rewrite** — iterate YAML fields, apply mode, create FlowSteps | Medium | ~80 |
| **Tests** — config loading, mode matrix, predicate mapping | Small | ~60 |
| **Total** | | **~305 lines** |

### What doesn't change
- FlowEngine, renderers, individual widget classes — untouched
- Config loader pattern in `src/config.ts` — reused as-is (deepMerge works)
- Existing `claude-proxy.yaml` — extended, not replaced

### What stays in code (not configurable)
- `onResult` callbacks — they transform widget output to session config shape
- `createWidget` runtime logic — directory scanning, user/group enumeration, remote list building
- Fork name uniqueness validation
- Conditional logic that depends on *accumulated state* (e.g., `users` field hidden when `hidden=true`)

The YAML declares *what*, the code handles *how*.

---

## What this unlocks

1. **Add a mode without code changes.** Want a "duplicate" mode? Add `duplicate: { visible: true, locked: false, prefill: true }` to each field in YAML. The code loop handles it.

2. **Reorder fields** by reordering YAML lines. No code touch.

3. **Add a new field** — add YAML entry + one widget factory case + one onResult handler. Two code touchpoints instead of modifying a 130-line function.

4. **Per-deployment customization.** An operator could override field defaults, hide fields, or change labels via their `claude-proxy.yaml` without forking.

5. **Future web form generation.** The same YAML can drive a browser form renderer — field list, labels, types, required/optional, locked/editable are all the data a form builder needs.

---

## Risk

**Low.** The only risk is over-engineering the YAML schema for future flexibility we don't need yet. Mitigation: start with the 12 fields and 4 modes we have now. No schema versioning, no plugins, no field type registry beyond the 5 widget types that exist. Extend later if needed.

The accumulated-state conditions (`not-hidden`, `not-hidden-and-not-public`) are a small complexity pocket — they reference other field values at runtime. The predicate registry handles this cleanly but it's the one place where YAML + code interact non-trivially.

---

## Recommendation

**Do it.** ~305 lines of new code, low risk, and it directly serves the "one screen for all modes" goal. The field × mode matrix from the authoring agent's reply is already YAML-shaped — the corrected matrix table maps 1:1 to the config structure above. We'd be writing it as code anyway; writing it as config costs the same up front and pays back on every future change.
