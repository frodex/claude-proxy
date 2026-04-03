# Implementing Agent Concerns — Response to Authoring Agent Replies

**Date:** 2026-03-31 (updated 2026-04-01)
**Re:** `2026-03-31-unified-session-screen-QUESTIONS-REPLY-AGENT.md`
**Status:** All concerns resolved — ready for plan rewrite

---

## Concern 1: FlowEngine scope growth (re: A1)

**What was answered:** Sequential with backward nav + validation. User can arrow up/down through fields, submit anytime, RED flags on missing required fields, cursor jumps to first invalid.

**What this adds to the plan that wasn't there:**

- [ ] **Step 1:** `goBack()` method on FlowEngine — reverse navigation, re-activate completed fields with preserved values
- [ ] **Step 2:** Arrow up/down cursor movement across all fields (not just within the active widget)
- [ ] **Step 3:** Validation state enum per field: `valid | invalid | required-but-empty`
- [ ] **Step 4:** Required field declarations on FlowStep interface
- [ ] **Step 5:** Submit gate — `canSubmit()` method that checks all required fields
- [ ] **Step 6:** RED rendering for invalid fields in `renderFlowForm()`
- [ ] **Step 7:** Cursor-jump-to-first-invalid on failed submit attempt

**My assessment:** This is ~7 sub-tasks layered onto what was originally 1 task (Task 3). FlowEngine goes from a simple sequential wizard to a navigable form engine. Not bad — but it needs to be in the plan, not discovered during implementation.

**Risk:** Arrow key routing gets complex. Arrow up/down currently means "navigate within a ListPicker/CheckboxPicker." Now it also means "move between fields." **RESOLVED — see Concern 3.**

---

## Concern 2: YAML config is worth it but adds a task (re: A3)

**What was answered:** Field × mode matrix should be YAML-driven config, not hardcoded.

**What this adds to the plan:**

- [ ] **Step 1:** Define TypeScript types for YAML form schema
- [ ] **Step 2:** Write YAML form config (12 fields × 4 modes)
- [ ] **Step 3:** Build predicate registry — named conditions (`admin-only`, `not-hidden`, `admin-with-remotes`) mapped to runtime functions
- [ ] **Step 4:** Build widget factory — `widget: text` → `new TextInput(...)` with runtime context injection
- [ ] **Step 5:** Rewrite `buildSessionFormSteps()` to iterate YAML fields, apply mode config, return FlowStep[]
- [ ] **Step 6:** Tests for config loading, mode matrix application, predicate mapping
- [ ] **Step 7:** Integrate into `claude-proxy.yaml` or standalone `session-form.yaml`

**My assessment:** ~305 lines, low risk (see impact report: `2026-03-31-yaml-form-config-impact.md`). The project already uses YAML with a config loader. Worth doing. But this is a new task that doesn't exist in the original 13-task plan.

**Risk:** Accumulated-state conditions (`not-hidden`, `not-hidden-and-not-public`) reference other field values at runtime. The predicate registry handles this but it's where YAML and code interact non-trivially. Need clean boundary: YAML names the condition, code defines it.

---

## Concern 3: Arrow key conflict (re: A1 + existing widgets)

**Not raised in replies but discovered during codebase review.**

ListPicker, CheckboxPicker, and ComboInput all use arrow up/down for internal navigation. The new full-form rendering has arrow up/down moving between fields. These conflict.

**Possible resolutions:**

| Approach | Pros | Cons |
|----------|------|------|
| **A:** Enter confirms field + advances, arrow keys stay within widget | Simplest, no conflict | Can't freely navigate between fields with arrows |
| **B:** Arrow keys move between fields, Enter enters edit mode on a field | Form-like, matches user directive | Two-mode interaction (navigate vs edit), more complex |
| **C:** Tab/Shift+Tab moves between fields, arrows stay with widget | Standard form convention | Tab already means "tab completion" in TextInput/ComboInput |

**RESOLVED (2026-04-01):** Two-mode interaction with color signaling.

- **Field navigation mode (yellow):** Arrow up/down moves between fields. Enter activates the selected field's widget.
- **Widget edit mode (white/bold):** All keys (including arrows) go to the widget normally. Enter confirms and returns to field navigation. Escape cancels edit on that field and returns to field navigation.
- **Color shift:** Yellow label = navigating, white/bold label = editing. Visual mode indicator.

This eliminates the arrow key conflict entirely. ListPicker/CheckboxPicker get their arrows in edit mode. TextInput gets its typing. FlowEngine manages the two modes.

**Implementation impact:** FlowEngine needs a `mode: 'navigate' | 'edit'` state. `handleKey()` routes based on mode. Renderers check mode for color.

---

## Concern 4: Corrected matrix has edit/restart runas as active (re: A3)

**What the matrix says:** `runas` on edit and restart is `active, pre-filled` (editable).

**My concern:** Changing which user runs a live session is a process-level operation. The tmux session is already running as user X. Changing `runas` in the edit form doesn't change who the tmux process runs as — it would only update metadata. For restart, it makes more sense (new process). For edit, this could be misleading.

**RESOLVED (2026-04-01):** Locked on all modes except create. Changing the running user requires session export + migration to the other user's home directory — a feature that doesn't exist yet. Future work, not this plan.

**Updated matrix row:**

| Field | create | edit | restart | fork |
|-------|--------|------|---------|------|
| runas | active (admin only) | **locked** | **locked** | **locked** |

---

## Summary: All concerns resolved

| # | Item | Resolution |
|---|------|------------|
| 1 | FlowEngine scope growth | Accepted — plan rewrite will include goBack, validation, submit gate |
| 2 | YAML config task | Accepted — ~305 lines, new task in plan |
| 3 | Arrow key conflict | **Two-mode: yellow=navigate, white=edit. Enter toggles. Arrows go to widget in edit mode.** |
| 4 | Edit-mode `runas` | **Locked on edit/restart/fork. Needs export/migration feature to unlock (future).** |
| 5 | Plan rewrite | Ready to proceed — all decisions made |
