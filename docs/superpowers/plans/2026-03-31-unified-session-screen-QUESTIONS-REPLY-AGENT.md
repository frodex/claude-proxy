# Answers to Implementing Agent — Unified Session Screen

**From:** Authoring agent (c9510550) + user review
**To:** Implementing agent
**Date:** 2026-03-31
**Re:** Questions blocking Tasks 3+

---

## A1: Sequential walk-through with validation, NOT random-access

**Answer: (A) with modifications.**

Sequential walk-through is intentional. The user SEES all fields at once (full-form rendering) but advances through them one by one with Enter. This is the "lobby style" — works like a form where you tab through fields.

**Key addition from user review:** The form won't submit unless required fields are complete. If the user tries to submit (reaches the end) with missing/invalid fields, those lines flag RED. The user must go back and fix them.

This means FlowEngine needs:
- Forward navigation (Enter advances)
- **Backward navigation** (arrow up goes back to previous completed field to re-edit)
- Validation state per field (valid, invalid, required-but-empty)
- Submit attempt that checks all required fields

This IS more than current FlowEngine supports. But it's NOT random-access — you still move sequentially, you just can go back. Think of it as a cursor that moves through the field list, not a menu where you jump anywhere.

**Implementation approach:** Add `goBack()` to FlowEngine. Arrow Up on any field goes to previous visible field, changes its state from `completed` back to `active`, preserves the accumulated value as the initial value for re-editing. Arrow Down or Enter advances.

---

## A2: displayValue callback — YES, use it

**Answer: Use the `displayValue` callback approach.** The `_display_` key convention is fragile. Your proposal is cleaner.

```typescript
interface FlowStep {
  // ... existing fields
  displayValue?: (accumulated: Record<string, any>) => string;
}
```

Each step definition includes its own display logic. FlowEngine calls it for completed steps in `getFlowSummary()`. If not provided, fall back to `String(accumulated[step.id])` or empty string.

---

## A3: Field × mode matrix — corrected by user

User reviewed and corrected the matrix:

| Field | create | edit | restart | fork |
|-------|--------|------|---------|------|
| name | active, empty | active, pre-filled | active, pre-filled | active, pre-filled as `X-fork_01`. **NO OVERWRITE of existing session names.** |
| runas | active (admin only) | active, pre-filled | active, pre-filled | **LOCKED** |
| server | active (admin only) | **locked** | **locked** | **locked** |
| workdir | active, empty | **LOCKED** | **LOCKED** | **LOCKED** |
| hidden | active, default N | active, pre-filled | active, pre-filled | active, pre-filled |
| viewOnly | active, default N | active, pre-filled | active, pre-filled | active, pre-filled |
| public | active (conditional) | active, pre-filled | active, pre-filled | active, pre-filled |
| users | active (conditional) | active, pre-filled | active, pre-filled | active, pre-filled |
| groups | active (conditional) | active, pre-filled | active, pre-filled | active, pre-filled |
| password | active, empty | active, pre-filled | active, pre-filled | **active, empty** |
| dangermode | active (admin only) | active, pre-filled | active, pre-filled | active, pre-filled |
| claudeSessionId | **hidden** | active, pre-filled | active, pre-filled | **locked** |

User corrections from original plan:
- **Fork name:** Must not overwrite existing session name. Validate uniqueness.
- **Fork runas:** LOCKED (can't change which user runs the fork)
- **Edit/restart/fork server:** LOCKED (can't move a session to a different host)
- **Edit/restart/fork workdir:** LOCKED (can't change working directory of existing session)
- **Fork password:** Empty, not inherited (security — fork is a new session)
- **Claude session ID on create:** Hidden (doesn't exist yet)

**User directive:** The menu field configuration should be YAML-driven if possible. The locked/visible/default state per field per mode should come from config, not hardcoded. Exception: fork name uniqueness check is code logic, not config.

---

## Additional User Directives

1. **Submit with errors → flag RED.** When the user reaches the end of the form and presses Enter to create/save, if required fields are missing or invalid, those field labels turn RED. The cursor jumps to the first invalid field. The user must fix it before the form will submit.

2. **One screen for init AND edit.** This is explicitly confirmed — the same SessionForm widget handles create, edit, restart, and fork. Different modes just change which fields are locked/hidden/pre-filled.

3. **YAML configuration for field modes.** The per-field-per-mode matrix should be configurable, not hardcoded. This keeps the form definition data-driven and allows future modes without code changes.

---

## Summary

| # | Question | Answer | Impact |
|---|----------|--------|--------|
| Q1 | Sequential vs random-access | Sequential with backward nav + validation | Add goBack() to FlowEngine, validation state to fields |
| Q2 | Display values approach | displayValue callback on FlowStep | Minor interface change, cleaner than _display_ keys |
| Q3 | Field × mode matrix | Corrected matrix above, YAML-driven config | Task 6 needs config loading, field state from YAML |

**You can now proceed with all phases.** Phase 1 (widget states) is unchanged. Phase 2 needs the FlowEngine additions (goBack, validation). Phase 3 uses the corrected matrix. Phases 4-5 unchanged.
