# Questions for Authoring Agent — Unified Session Screen Plan

**From:** Implementing agent (claude-proxy dev branch)
**Re:** `docs/superpowers/plans/2026-03-31-unified-session-screen.md`
**Date:** 2026-03-31
**Status:** Blocking implementation — need answers before starting

**Please save your response as:**
`docs/superpowers/plans/2026-03-31-unified-session-screen-QUESTIONS-REPLY-AGENT.md`

---

## Context

I've read the full plan and the full codebase. I'm ready to implement but I have three questions that affect architecture — not details I can figure out during implementation.

---

## Q1: Edit flow — sequential wizard or random-access menu?

**What the plan says (Task 7):**

> Replace startEditSession with SessionForm in edit mode

This means replacing the current **menu-based** edit flow with a **sequential FlowEngine** walk-through.

**What the codebase does today:**
The edit flow (`session-manager.ts:992`) is a menu. User sees all settings, picks one to change, edits it, returns to menu. If I only want to change the password, I select "Password" → type → done.

**What the plan would produce:**
A sequential walk-through of ALL fields: name → workdir → hidden → viewOnly → public → users → groups → password → dangermode. No way to skip to a specific field. FlowEngine has no "jump to step" capability.

**The question:**
Which of these do you intend? WORKS LIKE LOBBY, WONT SUBMIT UNLESS REQUIRED FIELDS ARE COMPLETE.  SUBMIT ATTEMPT WITH ERRORS FLAGS THE LINES WITH MISSING/ERRORS RED

**(A)** Sequential walk-through is intentional — user reviews every field on edit, even if they only want to change one. The "full-form rendering" means they SEE all fields but still advance one-by-one.

**(B)** Edit mode should be random-access — user sees all fields (full-form rendering) and can jump to any field to edit it. This requires adding cursor/jump support to FlowEngine that doesn't exist today.

**(C)** Something else I'm not seeing.

This is the biggest architectural question. Option B is significantly more work (new FlowEngine capability). Option A is a UX change from the current behavior.

---

## Q2: Display values — parallel `_display_` keys or a better approach?

**What the plan says (Task 3, Step 2):**

> `onResult` stores a `_display_<stepId>` key alongside the actual value

**The problem it's solving:**
Step IDs don't match accumulated keys. Actual mappings from `buildCreateSessionSteps`:

| Step ID      | Accumulated Key | Why different       |
| ------------ | --------------- | ------------------- |
| `runas`      | `runAsUser`     | Legacy naming       |
| `server`     | `remoteHost`    | Semantic difference |
| `workdir`    | `workingDir`    | Abbreviation        |
| `viewonly`   | `viewOnly`      | Casing              |
| `users`      | `allowedUsers`  | Prefix              |
| `groups`     | `allowedGroups` | Prefix              |
| `password`   | `passwordHash`  | It's hashed         |
| `dangermode` | `dangerMode`    | Casing              |

That's 8 out of 11 steps where ID ≠ accumulated key.

**My proposal:** Instead of doubling every `onResult` with a `_display_` key, add an optional `displayValue` callback to `FlowStep`:

```typescript
interface FlowStep {
  // ... existing fields
  displayValue?: (accumulated: Record<string, any>) => string;
}
```

Then `getFlowSummary()` calls `step.displayValue(accumulated)` for completed steps. Each step defines how to display its result. No parallel data path, no naming convention to remember.

**The question:** Are you attached to the `_display_` approach, or is the `displayValue` callback acceptable? It's a minor FlowStep interface change but cleaner.

---

## Q3: Which fields per mode? (Task 6 is underspecified)

**What the plan says (Task 6):**

> Accepts a `mode` parameter: 'create' | 'edit' | 'restart' | 'fork'

But it only sketches `claudeSessionId` as an example field. The actual creation flow has 11 steps. For each mode I need to know per-field:

- **Visible?** (condition returns true/false)
- **Locked?** (shown but not editable)
- **Pre-filled?** (initial value from source session)
- **Default behavior?** (what happens on Enter without input)

**Here's what I think the matrix should be — correct me:**

| Field           | create               | edit               | restart            | fork                                                                     |
| --------------- | -------------------- | ------------------ | ------------------ | ------------------------------------------------------------------------ |
| name            | active, empty        | active, pre-filled | active, pre-filled | active, pre-filled as `X-fork_01`OVERWRITE EXISTING FILENAME NOT ALLOWED |
| runas           | active (admin only)  | active, pre-filled | active, pre-filled | LOCKED                                                                   |
| server          | active (admin only)  | locked             | locked             | locked                                                                   |
| workdir         | active, empty        | LOCKED             | LOCKED             | LOCKED                                                                   |
| hidden          | active, default N    | active, pre-filled | active, pre-filled | active, pre-filled                                                       |
| viewOnly        | active, default N    | active, pre-filled | active, pre-filled | active, pre-filled                                                       |
| public          | active (conditional) | active, pre-filled | active, pre-filled | active, pre-filled                                                       |
| users           | active (conditional) | active, pre-filled | active, pre-filled | active, pre-filled                                                       |
| groups          | active (conditional) | active, pre-filled | active, pre-filled | active, pre-filled                                                       |
| password        | active, empty        | active, pre-filled | active, pre-filled | active, empty                                                            |
| dangermode      | active (admin only)  | active, pre-filled | active, pre-filled | active, pre-filled                                                       |
| claudeSessionId | hidden               | active, pre-filled | active, pre-filled | locked                                                                   |

**The question:** Is this matrix correct? Specifically:

MENU SHOULD BE YAML CONFIGURATION IF POSSIBLE (UNDERSTAND FORK NAME COULD BE EXCEPTION WITH NO FILE OVERWRITE)

- Should `runas` and `server` be locked on edit/restart/fork? (You can't change which user/host a running session uses without recreating it.)
- Should `password` on fork start empty or inherit?
- Should `claudeSessionId` be visible on create? (No session exists yet to have one.)

---

## Summary

| #   | Question                                    | Blocks        |
| --- | ------------------------------------------- | ------------- |
| Q1  | Sequential vs random-access edit            | Tasks 5, 6, 7 |
| Q2  | `_display_` keys vs `displayValue` callback | Task 3        |
| Q3  | Field × mode matrix                         | Task 6        |

I can start Phase 1 (Tasks 1-2) now — those are independent of these answers. But I'll block on Phase 2+ until I hear back.
