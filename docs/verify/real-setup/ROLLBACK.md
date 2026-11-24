# Rollback set: the real-setup run (2026-11-24)

Saved before anything changed on the PC or the VPS. The owner approved, for this run only, installing a build of
`feat/gamedev-tools` over Toki 0.5.4 and deploying it to the server (`crm-agency`).

## PC

| What | Where | Check |
|---|---|---|
| Toki 0.5.4 installer (the GitHub release asset) | `C:\Users\alex\pr-rollback-gamedev-20261124\PocketRocket_0.5.4_x64-setup.exe` | sha256 `c6a8b451f13ef39a814c49fc3767068c7f5a56e897c5c773a97d06b81735b862`, 35 842 145 B |
| The old app config (`mode: "remote"`, 107 B) | `C:\Users\alex\pr-rollback-gamedev-20261124\config.json` | sha256 `2D3B79733F57044F579DB90984F3ECFBAF9760ED10694D9408BCF10A16B6905F`, the same as the live file before the install |

- **Not zipped: `%LOCALAPPDATA%\PocketRocket`.** C: had 11 GB free, and the release installer is enough to restore the app.
- **Before the run:**
  - `PocketRocket.exe` 0.5.4 was running as PID 19216.
  - It had a tunnel `ssh -L 7788:127.0.0.1:7788 crm-agency`, so 7788 on this PC was the server.
  - Port 7789 belongs to the PC runner (`%LOCALAPPDATA%\PocketRocketRunner`, its own ssh). It was not touched.

To put the PC back:

```powershell
# 1. Quit Toki from the tray (Quit), then:
Copy-Item C:\Users\alex\pr-rollback-gamedev-20261124\config.json "$env:APPDATA\com.pocketrocket.app\config.json" -Force
# 2. Reinstall 0.5.4 over the test build (per-user, keeps data):
& C:\Users\alex\pr-rollback-gamedev-20261124\PocketRocket_0.5.4_x64-setup.exe /S
# 3. Start it:
Start-Process "$env:LOCALAPPDATA\PocketRocket\PocketRocket.exe"
```

The new build only reads the old config; it does not rewrite it (see README.md). Step 1 is still there in case
Connection settings were saved during the run.

## VPS (`crm-agency`)

| What | Value |
|---|---|
| `df -h /` before | 96G size, 84G used, 13G free (87%) |
| Commit before | `dee0210308ca257bf56f914dfc9294d330c12b45` (origin/main, "Merge pull request #250"). No tracked file was modified. The untracked leftovers were the known ones: `.codex/`, `deploy/claudebot-screen.service`, `packages/hub/src/grep.exe.stackdump`, `packages/site/assets/rocket.svg`, `packages/web/src/components/BotGroups.tsx` and `RocketMark.tsx` |
| DB backup | `/root/pr-predeploy-20261124-132057.db`, made with python `sqlite3` `.backup()` from a read-only connection: 167 460 864 B, `integrity_check` ok, 10 799 messages, 54 bots |
| Deployed | `a2c0e3b` (feat/gamedev-tools with origin/main merged in), at 13:36:51 UTC |

- **The schema change is additive.** Migrations 330 and 331 add `projects.kind` and the tables `remote_hosts` and `project_stubs`.
- **dee0210 ignores them,** so a code rollback can keep the live DB. Restore the backup only if the data itself is damaged; doing so drops every message written after 13:20 UTC.

To roll the server back to dee0210:

```bash
D=/c/Users/alex/Desktop/toki-rollback-$(date +%Y%m%d-%H%M%S)
cd /c/Users/alex/Desktop/claude-grokbot-spec-gamedev && git fetch origin && \
  git worktree add --detach "$D" dee0210 && cd "$D" && pwd && git log -1 --format='%h %s' && \
  test -z "$(git status --porcelain)" && SKIP_SCREEN=1 DEPLOY_ANY_TREE=1 bash scripts/deploy.sh crm-agency
# then:
ssh crm-agency 'curl -s http://127.0.0.1:7788/api/health; systemctl show pocketrocket -p NRestarts; journalctl -u pocketrocket -n 50 --no-pager'
```

- **deploy.sh overlays files and does not delete.** The branch's new source files stay on disk, but they are harmless, because the service runs the rebuilt `dist/hub.mjs`.
- **Only if the DB must go back as well:**

  ```bash
  ssh crm-agency 'systemctl stop pocketrocket && cd /home/pocketrocket/pocketrocket/data && \
    mv pocketrocket.db pocketrocket.db.bad-$(date +%s) && rm -f pocketrocket.db-wal pocketrocket.db-shm && \
    cp /root/pr-predeploy-20261124-132057.db pocketrocket.db && chown pocketrocket:pocketrocket pocketrocket.db && \
    systemctl start pocketrocket'
  ```
