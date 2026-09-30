# NAVIA project instructions

Read `CLAUDE_CODE_MASTER_PROMPT.md` completely before making changes.

This repository is a real resilient-navigation product, not a visual mockup.
Preserve the architecture, test every navigation subsystem, and never replace real functionality with hardcoded demo values.

Authoritative product spec and work protocol (owner, 30.09.2026): `docs/NAVIA_MASTER_SPEC.md` and `docs/NAVIA_PRODUCT_SPEC.md` (backlog B0–B10, acceptance). Living baseline/audit: `docs/BASELINE.md`. Earlier plan and report format: `docs/NAVIA_TZ.md`, product rules `docs/NAVIA_CONSTITUTION.md`. See also `AGENTS.md`.

Read also:
- `docs/ARCHITECTURE.md`
- `DATA_PIPELINE.md`
- `BUILD.md`

When uncertain, favor:
1. real sensor/data path;
2. explicit unavailable state;
3. deterministic tests;
4. safe low-confidence behavior.
