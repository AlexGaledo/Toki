# AGENTS.md

Toki (npm name `pocketrocket`): a messenger for a team of Claude bots that run on the owner's PC or VPS with their own subscription.
`packages/hub` (Node, agent SDKs, SQLite, REST/WS on 127.0.0.1:7788), `web` (React UI), `shared` (zod models + protocol), `desktop` (Tauri shell), `site` (landing page), `deploy/` (VPS).
No architecture map here: read the code. Entry points: `packages/hub/src/hub.ts`, `packages/web/src/main.tsx`, `packages/desktop/src-tauri/src/lib.rs`. Human guide: `docs/DEVELOPMENT.md`.

## Build, test, lint
```bash
pnpm install && pnpm dev   # hub + Vite UI at http://127.0.0.1:5173
pnpm build                 # typecheck + build every package
pnpm test                  # vitest in every package + node --test scripts/*.test.mjs
pnpm lint                  # ESLint ratchet; fix or `// eslint-disable-next-line <rule> -- reason`
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml   # any Rust change
```

## Prove a change
- Logic: a test next to the code that fails without your change. Security changes need a negative test.
- UI: the `verify-toki` skill (`.claude/skills/verify-toki`, driver `node scripts/control-toki.mjs`); put its screenshot + ARIA snapshot in the PR.
- Never hand the owner a check you could run. Paste real results, including failures.

## When the owner corrects you twice (/correct, after Lauren Tan's pstack, MIT)
1. Fix it, then make it impossible, highest level first: architecture (one owner, one way, delete the old way) > types > a lint whose message names the fix > a test.
2. Prose is last, and only for a judgment call.
3. Prove the new check fails on the real past mistake.
4. Add the row below. A listed rule with no enforcer is a repeat: move it up a level in the same change.

## Rule → Enforcer
| Rule | Enforcer |
|---|---|
| Hub logs caught errors with `logError()`, not `console.error` | `eslint.config.js` no-restricted-properties |
| Web: no `confirm/alert/prompt`; use `confirmAction()`/`ConfirmDialog`/`Banner` | `eslint.config.js` no-restricted-globals |
| Only the Radix packages in `packages/web/package.json`; icons from lucide-react only | `eslint.config.js` no-restricted-imports |
| web/shared never import hub; shared never imports web | `eslint.config.js` no-restricted-imports |
| No empty `catch`; `setTimeout` in web needs a reason; every disable says `-- why` | `eslint.config.js` (all proven in `scripts/lint-rules.test.mjs`) |
| Migrations: unique ascending ids inside a block, never DROP/RENAME (SQLite and Supabase) | `packages/hub/src/db/migrationRules.test.ts` |
| A route a paired phone may call is added to `DEVICE_ALLOW` on purpose | `packages/hub/src/api/deviceAllow.test.ts` + `__snapshots__/deviceAllow.txt` |
| Design tokens match across web, desktop splash and site | `scripts/token-parity.test.mjs` |
| WCAG AA text contrast in both themes | `scripts/contrast.test.mjs` |
| Workflows: actions SHA-pinned, minimal top-level `permissions` | `scripts/workflows.test.mjs` |
| Never `StrictHostKeyChecking=no` | `scripts/ssh-host-keys.test.mjs` |
| Keep each file's line endings; scripts are LF | `scripts/repo-guards.test.mjs`, `.gitattributes` |
| Released CHANGELOG sections are append-only; merge it by hand | `scripts/changelog-guard.mjs` (CI) |
| Deploy only from a clean, current origin/main | `scripts/deploy.sh` refuses otherwise |
| Versions in sync; tag = package.json; release needs its CHANGELOG section | `scripts/version.mjs --check` (CI), `release.yml` |
| Hub binds loopback only; Host/Origin check, token guard, auth rate limit, body caps | `HOST` in `hub/src/config.ts`; `hub/src/api/guard.test.ts` |
| Bot CLIs never get `POCKETROCKET_TOKEN` | `hub/src/providers/env.test.ts` |
| Approvals default to `ask`; routine/trigger turns card even under bypass | `permissions/bypass.test.ts`, `permissions/strictApprovals.test.ts` |
| Fleet changes by a bot ask first; every hub tool is registered silent or gated | `agent/fleetApproval.test.ts`, `permissions/toolRegistry.test.ts` |
| Computer/VNC/CDP ports on loopback; backups skip `vault.key` | `hub/src/deployScripts.test.ts` |
| Desktop webview navigates only to splash + hub; release builds ignore `hubDir` | `lib.rs` tests (`cargo test`, CI) |
| Web entry chunk stays lean (no workflow canvas, size budget) | `scripts/bundle-budget.mjs` (CI) |

Unenforced (no check yet; keep until one exists):
- Never log or print a token, device token or pairing code; the hub token appears only in the first `#token=` fragment.
- A changed SSH host key is always refused; an unknown one is accepted only after its fingerprint was shown.
- No user content leaves the machine; outbound hosts are listed in `docs/PRODUCTION-CHECKLIST.md`.
- Shell scripts are idempotent and quote every variable; PowerShell/NSIS never interpolates a path into code.
- Never grow `eslint-suppressions.json` by hand or with `--suppress-all`.
- Web: secrets are masked (`Private`), untrusted trigger text renders as plain text, phone UI hides what the hub refuses.

Judgment (no check):
- Smallest change that fits; copy the nearest good example, not the nearest example.
- Reuse `packages/web/src/components/ui.tsx` primitives; one accent colour; no new motion without a reason; check both themes, narrow layout, keyboard and reduced motion.
- Stay in your scope (`.claude/agents/`); list cross-scope work for its owner.
- Owner decisions (pricing, platform priority, provider choice) are open questions, never yours.
- Never commit, push, merge, deploy or tag unless asked.
