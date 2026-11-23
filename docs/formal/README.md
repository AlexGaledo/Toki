# Formal models

TLA+ models of hub logic where a test can only try the cases someone thought of. `pnpm formal` (or `node scripts/formal.mjs`) downloads a pinned `tla2tools.jar`, needs Java 11+, and runs TLC on every `.cfg` here.

- `<Spec>.cfg` must pass.
- `<Spec>Broken.cfg` models a known-bad version and must fail, which proves the invariants catch that bug.

| Model | Code | Checks |
|---|---|---|
| `CutOff.tla` | `RoomRouter.afterCutOff`, `BotRunner` session rotation | retries are bounded; a step-limit retry keeps its session unless the context was large; only the token brake or a large context starts fresh; an owner's request never ends without a note or a coordinator; every request ends |

When you change the code a model mirrors, change the model in the same PR. Add a model when the logic is a state machine with retries, races or limits.
