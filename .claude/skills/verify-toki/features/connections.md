# Settings › Connections

Connections are accounts every bot can use (GitHub, Google, and other apps). Logins are stored encrypted on the server and never reach a bot; sending or posting asks first.

## Sub-features

- `conn-list` lists `GitHub` and `Google`, each with a blurb and `Connect`, and the `In the browser` card for WhatsApp and social media.
- `conn-connect` `Connect` unfolds that app's sign-in forms (OAuth app or token / device code).
- `conn-status` badge `Connected`, `Reconnect needed` or `Error`.
- `conn-disconnect` `Disconnect` with a confirm group `Disconnect <app>`.
- `conn-other` `Other apps` disclosure: Slack, ClickUp, Microsoft Teams.

## How to get to it (user POV)

- Profile menu (`Menu for <user>. Online`) › `Settings` › tab `Connections`.

## Driving it with control-toki

Preconditions:

- Baseline run; no connections.

- **Open.** `$C click --role button --name "Menu for Verifier. Online"`, `$C click --role menuitem --name Settings`, `$C click --role tab --name Connections`. `tabpanel "Connections"` with `heading "Connections"` level 2 and the sentence `Accounts your bots can use. ...`.
- **List.** `heading "GitHub"` and `heading "Google"` level 3, each with `button "Connect"`; `heading "In the browser"`; `group: Other apps`.
- **Unfold (no network).** `$C click --role button --name Connect --nth 0 --in tabpanel:Connections`. Under GitHub a `tablist` with `Sign in` (one-time OAuth app setup: `Client ID`, `Client secret`, disabled `Save and connect`) and `Paste a token`. `Escape` closes Settings without saving.
- **Other apps.** `$C click --text "Other apps" --exact`. `heading "Slack"`, `heading "ClickUp"`, `heading "Microsoft Teams"`, each with `Connect`.
- **Second view.** `$C api GET /api/integrations` reports no connections.
- **Proof.** `$C snapshot --path connections/list.aria.yml`, `$C screenshot connections/list.png`.

## Gotchas

- Finishing a sign-in leaves the machine (OAuth in the system browser, a GitHub/Google account). Report `conn-connect` past the form, `conn-status` and `conn-disconnect` as BLOCKED in a throwaway run.
- Never paste a real token into a throwaway run's form for a proof; the run's data dir is deleted, but the token still left the vault.
- `Other apps` is a `<details>` (`group: Other apps` with no name); its rows only enter the ARIA tree once opened, and only `click --text "Other apps" --exact` opens it.
- The OAuth callback shown in the setup steps uses the run's vite port (`http://127.0.0.1:<port>/oauth/callback/github`), not 7788.
- Settings is a modal dialog; everything behind it is inert until `Close` or `Escape`.
