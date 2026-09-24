# NAVIA project instructions

Read `CLAUDE_CODE_MASTER_PROMPT.md` completely before making changes.

This repository is a real resilient-navigation product, not a visual mockup.
Preserve the architecture, test every navigation subsystem, and never replace real functionality with hardcoded demo values.

Current iteration plan, owner decisions and report format: `docs/NAVIA_TZ.md` (takes priority), with `docs/NAVIA_CONSTITUTION.md` for product rules. See also `AGENTS.md`.

Read also:
- `docs/ARCHITECTURE.md`
- `DATA_PIPELINE.md`
- `BUILD.md`

When uncertain, favor:
1. real sensor/data path;
2. explicit unavailable state;
3. deterministic tests;
4. safe low-confidence behavior.
