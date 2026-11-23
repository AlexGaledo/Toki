# Lauren Tan — "All Code Is Slop (Except Mine)": review and action plan

Date: 2026-11-23. Source: AI Engineer talk, https://www.youtube.com/watch?v=O_zcc6Xl12g (17 min, full transcript read). Speaker: Lauren Tan (@poteto), Grok Bot team, SpaceXSI.
Also read: pstack skills (github.com/cursor/plugins/tree/main/pstack), poteto/verification-skill-example, Bombadil docs. Toki audited at origin/main c5d788c.

Owner decisions (2026-11-23 interview): apply to the Toki codebase, Toki bots' behavior and other projects; **aggressive cut** of prose rules; output = report + ranked plan, nothing changes until approved.

## 1. The talk in one paragraph

Agents copy whatever your codebase already does, so the codebase is the biggest prompt you have. Build trust in agents bottom-up through an **inverse pyramid**:
1. Code and architecture that make wrong things impossible.
2. Deterministic checks: lint rules, types, compiler, tests.
3. Verification, both runtime and formal.
4. A thin layer of prose (rules, skills, AGENTS.md) only for what needs judgment.

Every correction you give an agent should become a check, not another line of prose. Do that enough and nothing is left to review: agents merge their own PRs and review becomes looking at evidence. Her team shipped 11,000 PRs in one month with a 0.5% revert rate, and the app got *faster*. Most of their tokens go to verification. Build the foundations before you automate: "if your inner loop produces slop, automating it produces more slop."

## 2. Claims and mechanics (what she actually says)

| # | Claim / practice | Timestamp | Evidence in pstack |
|---|---|---|---|
| 1 | Turn every correction into a deterministic check, not another rule line, because a check is "far more reproducible" | 3:13, 9:11 | `correct` skill, `principle-encode-lessons-in-structure` |
| 2 | Anything that needs nuance to use well turns into slop, so ban it in product code (e.g. `useEffect`, allowed only inside the framework) | 5:27 | — |
| 3 | Directory structure carries context: `electron-main` vs `electron-renderer` imports are banned by a dependency-graph analyzer plus lint | 6:11 | not public |
| 4 | Agents use markdown (comments, docs, rules) to justify skipping the right fix, and over-rotate on small corrections, treating them as hard rules | 6:57 | `no-comments`, Comment Sicko |
| 5 | Ban about 99% of comments: they go stale, nobody reads them, they give agents an escape hatch, and they can't be enforced | 8:21 | Comment Sicko keep-list |
| 6 | Lint error messages tell the agent to **fix the root cause** | 8:56 | `correct`: "error names the file, type, or function to use instead" |
| 7 | Review shrinks to verification artifacts: videos, screenshots, diagrams, formal results | 9:50 | `create-verification-skill` Evidence section |
| 8 | Runtime verification: the agent runs the app itself over CDP | 10:02 | `verify-<app>` skill |
| 9 | **Feature map**: a site map of features from the user's point of view, so "the thingy in the left sidebar" has a shared name | 10:19 | 4-section feature files |
| 10 | Custom CLIs/drivers inside skills, reused on every run, which saves tokens and is testable | 10:38 | `control-<app> doctor/snapshot/aria-click` |
| 11 | TLA+ model checking of user flows (multi-device notifications); Lean for algorithms | 10:51 | `statechart`, `create-formal-verification-skill` (Lean unverified) |
| 12 | Property-based UI testing with Bombadil | 11:36 | antithesishq/bombadil |
| 13 | About 70% of tokens go to verification. Verification used to be too expensive; agents make it cheap — "golden age of testing" | 11:52 | — |
| 14 | The `statechart` skill draws state machines from the user's point of view, which are easy to review | 13:02 | `statechart` |
| 15 | Foundations before a "software factory". Each release spins up an agent project that fuzzes the app like a user and opens and automerges fix PRs | 15:11 | not public |

### The most useful mechanics from pstack (verbatim where quoted)

- **/correct loop.** A mistake class "counts once it has happened twice". Fix it in this order, stopping at the first that works:
  1. architecture ("Hide internals so the wrong import fails")
  2. types
  3. a lint/CI check whose error names what to use instead — "if the pattern is already common, fail only when a change adds more" (a ratchet)
  4. a behavior test
  5. docs/rules last ("Nothing fails when an agent skips them")

  "Prove each new check fails on a real past mistake." Keep a **rule → enforcer table**; a rule with no enforcer "is a repeat".
- **Exceptions** go on the offending line with a reason, an expiry date and a human's approval.
- **Comment Sicko.** Delete by default. Keep only: license headers, gotchas forced by external platforms, `prettier-ignore`, public API docs, issue links. "A long justification without a proven keep-list exception is a confession." For a "do not remove" comment, encode it as a type, test or lint, then delete the comment.
- **verify-<app> skill.** Sections: Launch ("ready means usable"), Doctor (one read-only health check), Drive (real selectors), Evidence (action + resulting state + a read-only second view), Cleanup ("kill what you started", keep the evidence). "A generated skill that was never executed is a draft."
- **Feature file** = exactly 4 H2s: Sub-features / How to get to it (user POV) / Driving it with <harness> / Gotchas. "Never weaken the journey to make it pass." The map doubles as the regression order.
- **interrogate.** "Break this change. Prove each finding with a run against the real code … Leave out anything you did not run." Only findings that reproduce survive.
- **swarm.** Workers report PASS / ISSUES / BLOCKED with evidence. "A gap does not count as a pass."
- **attack-the-premise.** After 2 failed fixes on the same premise, write the premise down and test it before trying a 3rd fix.
- **poteto-mode.** "Never hand the human a check you could run." Reversible work goes ahead; irreversible writes pause.

### Caveats
- Lean use, the 70% figure, the dependency analyzer and the release-fuzz automerge are claimed in the talk; nothing about them is published.
- Her numbers come from a large funded team on one Electron app. The 0.5% revert rate depends on years of foundations.
- The pstack README still says she ships "at Cursor" (it predates her move).

## 3. Where Toki stands (origin/main c5d788c)

| Pyramid layer | Toki today | Verdict |
|---|---|---|
| Architecture | Clean package split (web/shared never import hub), zod at boundaries (51 of 69 API files parse input) | good, but **nothing enforces the split** |
| Lint | **None at all**: no eslint/biome/oxlint, no import-boundary check. 9 orphan `eslint-disable` comments | biggest gap |
| Types | `strict: true`; missing `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`. 127 `as unknown as`, 383 `!.` | ok |
| Tests | 221 vitest files, CI runs build + test + cargo check. Web tests run in a `node` env, so no component rendering | good on logic |
| Runtime verification | **None for the app.** No Playwright/CDP harness, no feature map. Manual `scripts/smoke.mjs` WS drivers are the seed | gap |
| Formal | none | later |
| Prose | ~4,160 words across 4 `.claude/agents/*.md`, **already drifted** (e.g. "Radix Dialog and Tabs only" vs 3 more Radix deps; line-number maps). `PromptBuilder.ts` is ~25 KB of bot prose | too much, as she warns |
| Comments | ~8% of src lines; long narrative comments with phase tags ("P6 (6.3):") | agents copy this |
| Anti-patterns | 65 non-test `setTimeout(` (her exact example), 72 empty `catch {}`, 36 `.catch(() => {})`, 6 raw `console.error` despite the logError rule | ratchet targets |

**Bots.** The talk's core loop is missing. When the owner corrects a bot, the correction becomes **more prose**: SkillDistiller → new SKILL.md, AutoMemory → memory.md, routing.md. It never becomes an executable check. Nothing makes a bot produce evidence (test run, screenshot) before it says "done", even though it has `browser_take_screenshot`/`desktop_screenshot`. The safety layer is the exception: PermissionBroker, classifyBash, approval cards and cost caps are real gates, not prose. That is the talk's model working.

## 4. Action plan (ranked; nothing starts until approved)

Owner chose the **aggressive cut**: prose stays only for judgment. Every remaining rule must name its enforcer, or be deleted.

### A. Toki codebase

| # | Change | Size | Why first |
|---|---|---|---|
| A1 | Add **oxlint** (fast, zero-config) + CI gate in **ratchet mode** (baseline file; fail only on new violations). Rules: no-console-error in hub (→ `logError`), no-restricted-globals confirm/alert/prompt (→ ui.tsx dialog), no-restricted-imports (web/shared ✗ hub; Radix allowlist), no empty catch. Custom messages name the fix. | S | Turns the top 10 prose rules into checks. Biggest gap |
| A2 | **Boundary check**: package import rule (web/shared/desktop-ui cannot reach hub internals) | S | Her "context via directory structure" |
| A3 | **Rule → enforcer table** in a new root `AGENTS.md` (≤60 lines). Cut `.claude/agents/*.md` to scope + judgment calls only; delete line-number maps (point to code). Target ≤1,000 words total, from 4,160 | M | Aggressive cut; drift already proven |
| A4 | Convert agent rules into tests: migration-ID block/no-DROP test, `DEVICE_ALLOW` snapshot test, token-parity test (index.css / desktop / site), WCAG contrast test, workflow-pinning check (actionlint/zizmor) | M | Each replaces a prose paragraph |
| A5 | **Comment Sicko pass**, one package at a time. Delete narrative/phase-tag comments; turn "don't do X" comments into a type/lint. Add a lint ratchet on new block comments in `packages/*/src` | M | Stops agents copying the style |
| A6 | **verify-toki skill + feature map**: Launch (hub + web dev), Doctor (`/api/health`), Drive (Playwright over real selectors), Evidence (screenshot + ARIA snapshot + read-only second view), Cleanup. Feature files for rooms, DMs, approvals, connections, triggers, devices, files. Reusable `scripts/control-toki.mjs` driver built from smoke.mjs | L | Lets agents prove UI work, so review = evidence |
| A7 | Tighten tsconfig (`noUncheckedIndexedAccess` etc.) behind the same ratchet | M | Types layer |
| A8 | Later: statechart/TLA+ for one risky flow (approval cards or the device-pairing/push flow); Bombadil on the web app | L | Formal layer, after A1–A6 |

### B. Toki bots' behavior

| # | Change | Size |
|---|---|---|
| B1 | **"Done needs evidence" gate**: when a bot claims a code/UI change is done, its turn must include a test run or screenshot artifact, otherwise the hub marks the claim "unverified" on the card. Enforced in code, not prompt | M |
| B2 | **Correction → check**: extend SkillDistiller so that when a correction repeats (2nd time, per /correct), it proposes, in order: a check (lint rule / test / hook in the bot's project), a tool-level restriction (PermissionBroker rule), and only then a SKILL.md edit. The owner approves as today | M |
| B3 | **Cut PromptBuilder prose**: move every rule that is already enforced in code (permissions, caps, hops) out of the prompt; keep identity, judgment and tool pointers. Measure prompt size before/after | M |
| B4 | Ship pstack-style skills to the fleet (adapted, clean-room wording): `attack-the-premise` (2 failed fixes → write premise down), `interrogate` (only reproduced findings), swarm PASS/ISSUES/BLOCKED reporting for multi-bot rooms, and the "never hand the human a check you could run" rule | S |
| B5 | Room-level **feature map** convention for project rooms: `features/` with the 4 H2s, so bots and owner share names for UI parts | S |

### C. Other projects (Wika, MimeGen, reel3d, Laya)

| # | Change | Size |
|---|---|---|
| C1 | Per repo: add a linter in ratchet mode + rule → enforcer table (same template as A1/A3) | S each |
| C2 | Tindahan (Expo app) and the Wika dashboard: verify-<app> skill + feature map; these see the most UI churn | M each |
| C3 | MimeGen/reel3d: verification = render a short test clip + frame snapshot as evidence before "done" (fits the reel quality bar) | M |

### Suggested order
A1 → A2 → A3 (one PR each), then B1 + B4, then A6, then the rest. A1–A3 are small and remove most of the prose debt the talk warns about.

## 5. Open questions for the owner
- Merge policy: she lets agents automerge once checks are strong. Toki stays human-merge for now. Revisit after A1–A6?
- B1 "unverified" labelling: a soft label, or block the bot from reporting done?
