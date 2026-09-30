# NAVIA project instructions

Read `docs/NAVIA_PRODUCT_SPEC.md` first: it defines the product, the co-pilot
("Штурман") behaviour, the prioritized backlog (B0–B10), acceptance criteria and
the mandatory work protocol (section 8: one backlog item at a time, failing test
first, full regression before commit, evidence report in the 8.3 format, no fake
data, no phrase-specific `if`s, no keys in code or chat, never merge the PR).

Then read `CLAUDE_CODE_MASTER_PROMPT.md` completely before making changes.

This repository is a real resilient-navigation product, not a visual mockup.
Preserve the architecture, test every navigation subsystem, and never replace real functionality with hardcoded demo values.

Read also:
- `docs/ARCHITECTURE.md`
- `DATA_PIPELINE.md`
- `BUILD.md`

When uncertain, favor:
1. real sensor/data path;
2. explicit unavailable state;
3. deterministic tests;
4. safe low-confidence behavior.
