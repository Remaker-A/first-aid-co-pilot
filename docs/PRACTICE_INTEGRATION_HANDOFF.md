# Practice Mode Integration Handoff

## Product Positioning

FirstAid Copilot remains an emergency-first product. Practice Mode is not a separate learning platform, video center, or quiz product. It is a non-emergency rehearsal surface for the same Copilot flow:

- Emergency mode: fast real-time guidance for an actual first-aid scene.
- Practice mode: safe rehearsal using the same auditable CPR flow, with real emergency tools disabled and a post-run debrief.

The intended first production scope is adult sudden collapse CPR only. Other scenarios can be explored as prototypes, but they should not be wired into production medical flow until the rule set and wording have been medically reviewed.

## What This Branch Ships

### Production Agent Core

- Adds `session_mode: "emergency" | "practice"` to session state.
- Keeps `"emergency"` as the default, so existing clients do not change behavior.
- Reuses the existing S0-S9 adult CPR state machine in practice mode.
- Auto-passes the S5 emergency-call gate in practice mode.
- Does not create `emergency_call` tools or `call_brief` in practice mode.
- Keeps `ActionValidator` safety checks active, including forbidden diagnostic wording.
- Adds a deterministic practice debrief for completed rehearsal sessions.

### Design Prototype Reference

The teammate prototype is included under:

```text
prototypes/practice-copilot/
```

It is intentionally isolated from production runtime code. It can be used as a UI/interaction reference for:

- First-use tutorial.
- Scenario entry cards.
- Guided practice vs scenario challenge framing.
- Simulated voice/camera interaction presentation.
- Final review/debrief screen structure.

It should not be treated as production medical logic. Choking and bleeding content in the prototype require medical review before production use.

## iOS Integration Contract

For the first iOS integration, the client only needs a thin mode switch.

Emergency entry:

```json
{
  "session_mode": "emergency"
}
```

Practice entry:

```json
{
  "session_mode": "practice"
}
```

If `session_mode` is omitted, the Agent Core behaves as emergency mode.

Recommended iOS behavior:

- Show one split entry: `Immediate Emergency` and `Practice Mode`.
- Add a visible practice-mode badge during rehearsal.
- In practice mode, expose pause/reset/replay controls.
- Render the debrief after completion.
- Do not expose production choking/bleeding flows yet.

## Review Guidance

Review this branch as one integrated practice-mode PR:

- Agent Core changes are production candidates.
- `prototypes/practice-copilot/` is a reference prototype.
- Android/iOS production UI is not modified in this branch.
- Main emergency behavior should remain unchanged when no `session_mode` is passed.

Suggested follow-up branches:

- `feat/practice-ios-entry`: iOS split entry and practice-mode badge.
- `feat/practice-debrief-ui`: native debrief rendering.
- `feat/practice-scenario-engine`: optional future scenario runner after medical review.
