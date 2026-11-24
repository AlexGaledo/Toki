# I4 on a clean folder: the built NSIS installer, silent, into a NEW empty folder under %TEMP%, then the hub started
# from that folder on a spare port, then a full removal. The owner's own install must stay registered and working.
#   powershell -NoProfile -ExecutionPolicy Bypass -File i4_clean_folder.ps1 -Setup <installer.exe> -Backup <dir>
# <dir> must hold uninstall-PocketRocket.reg and manufacturer-key.reg (reg export of the owner's keys, taken first).
# Toki must be quit first: the installer and the uninstaller both kill PocketRocket.exe by name (CheckIfAppIsRunning).
# Paths reach the installer as arguments and the hub as environment variables, never spliced into code.
param([Parameter(Mandatory)][string]$Setup, [Parameter(Mandatory)][string]$Backup, [int]$Port = 7821)
$ErrorActionPreference = 'Stop'
function Say($s) { (Get-Date -Format 'HH:mm:ss.fff') + ' ' + $s }
$UK = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PocketRocket'
$MK = 'HKCU:\Software\Alex Galedo\PocketRocket'
function Reg-State {
  $u = Get-ItemProperty $UK -ErrorAction SilentlyContinue
  $m = (Get-ItemProperty $MK -ErrorAction SilentlyContinue).'(default)'
  "uninstall key: " + $(if ($u) { "InstallLocation=" + $u.InstallLocation + " UninstallString=" + $u.UninstallString + " DisplayVersion=" + $u.DisplayVersion } else { '(absent)' }) + " | manufacturer default: " + $m
}
if ($Port -in 7788, 7789, 7790) { throw 'refusing a Toki port' }
if (Get-Process PocketRocket -ErrorAction SilentlyContinue) { throw 'quit Toki first: the installer kills PocketRocket.exe' }
foreach ($f in 'uninstall-PocketRocket.reg', 'manufacturer-key.reg') { if (-not (Test-Path (Join-Path $Backup $f))) { throw "missing backup $f" } }

$owner = Join-Path $env:LOCALAPPDATA 'PocketRocket'
$ownerExe = (Get-FileHash (Join-Path $owner 'PocketRocket.exe')).Hash
Say ("# I4 on a clean folder, installer sha256 " + (Get-FileHash $Setup).Hash.ToLower())
Say ("owner's install: " + $owner + ", PocketRocket.exe sha256 " + $ownerExe.Substring(0, 16) + "...")
Say ("before: " + (Reg-State))

$T = Join-Path $env:TEMP ('toki-i4-clean-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$App = Join-Path $T 'app'
New-Item -ItemType Directory -Force $T, (Join-Path $T 'data'), (Join-Path $T 'appdata'), (Join-Path $T 'localappdata') | Out-Null
Say ("new folder: " + $App + " exists before install: " + (Test-Path $App))

$hub = $null
try {
  # /D= must be last and unquoted; this path has no spaces. /NS: no shortcuts.
  $p = Start-Process -FilePath $Setup -ArgumentList '/S', '/NS', ('/D=' + $App) -PassThru -Wait
  Say ("installer exit code " + $p.ExitCode)
  Say ("after install: " + (Reg-State))
  $files = Get-ChildItem $App -Recurse -File
  Say ("installed: " + $files.Count + " files, " + [math]::Round(($files | Measure-Object Length -Sum).Sum / 1MB, 1) + " MB")
  $res = Join-Path $App 'hub\resources\blender'
  Say ("hub\resources\blender present: " + (Test-Path $res))
  $src = Join-Path (Split-Path -Parent $PSScriptRoot) '..\..\..\packages\hub\resources\blender'
  foreach ($f in Get-ChildItem $res -File) {
    $a = (Get-FileHash $f.FullName).Hash.ToLower(); $b = (Get-FileHash (Join-Path $src $f.Name)).Hash.ToLower()
    Say ("  " + $f.Name + " " + $f.Length + " B sha256 " + $a.Substring(0, 12) + "... source " + $b.Substring(0, 12) + "... equal=" + ($a -eq $b))
  }
  Say ("hub\package.json next to hub.mjs (so HUB_DIR is this folder): " + (Test-Path (Join-Path $App 'hub\package.json')) + " / " + (Test-Path (Join-Path $App 'hub\hub.mjs')))
  Say ("owner's PocketRocket.exe unchanged: " + ((Get-FileHash (Join-Path $owner 'PocketRocket.exe')).Hash -eq $ownerExe))

  # The hub from that folder: its own node.exe and hub.mjs, temp data, spare port, no Claude session variables.
  $tok = -join ((1..16) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = Join-Path $App 'node.exe'
  $hubMjs = Join-Path $App 'hub\hub.mjs'
  if ($hubMjs -match '[\s"]') { throw 'unexpected space or quote in the temp path' }
  $psi.Arguments = $hubMjs
  $psi.WorkingDirectory = Join-Path $App 'hub'
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  foreach ($k in @($psi.Environment.Keys)) { if ($k -match '^(CLAUDE|POCKETROCKET_)') { $psi.Environment.Remove($k) | Out-Null } }
  $psi.Environment['POCKETROCKET_DATA'] = Join-Path $T 'data'
  $psi.Environment['POCKETROCKET_WEB_DIST'] = Join-Path $App 'hub\web'
  $psi.Environment['PORT'] = [string]$Port
  $psi.Environment['POCKETROCKET_TOKEN'] = $tok
  $psi.Environment['APPDATA'] = Join-Path $T 'appdata'
  $psi.Environment['LOCALAPPDATA'] = Join-Path $T 'localappdata'
  $psi.Environment['NODE_NO_WARNINGS'] = '1'
  $hub = [System.Diagnostics.Process]::Start($psi)
  $outTask = $hub.StandardOutput.ReadToEndAsync(); $errTask = $hub.StandardError.ReadToEndAsync()
  Say ("hub started: pid " + $hub.Id + " " + $psi.FileName + " " + $hubMjs + " on 127.0.0.1:" + $Port)
  $h = @{ authorization = 'Bearer ' + $tok }
  $ok = $false
  for ($i = 0; $i -lt 60 -and -not $ok; $i++) {
    Start-Sleep -Milliseconds 500
    try { $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/health" -TimeoutSec 2; $ok = $r.StatusCode -eq 200 } catch { }
  }
  Say ("GET /api/health -> " + $(if ($ok) { '200 ' + $r.Content } else { 'no answer' }))
  $l = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
  Say ("listener: " + $l.LocalAddress + ":" + $l.LocalPort + " owned by pid " + $l.OwningProcess + " (" + (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $l.OwningProcess)).ExecutablePath + ")")
  $gt = Invoke-RestMethod "http://127.0.0.1:$Port/api/game-tools" -Headers $h -TimeoutSec 15
  Say ("GET /api/game-tools -> blender.reason=" + $gt.blender.reason + " uv.reason=" + $gt.uv.reason + " studio.reason=" + $gt.studio.reason)
  $web = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/" -TimeoutSec 5
  Say ("GET / (the bundled web) -> " + $web.StatusCode + ", " + $web.Content.Length + " B, has <title>: " + ($web.Content -match '<title>'))
} finally {
  if ($hub -and -not $hub.HasExited) { Stop-Process -Id $hub.Id -Force; $hub.WaitForExit(5000) | Out-Null; Say ("hub stopped (pid " + $hub.Id + ")") }
  if ($hub) { $log = ($outTask.Result + $errTask.Result) -split "`n" | Where-Object { $_ } | Select-Object -First 12; foreach ($x in $log) { Say ("  hub: " + ($x -replace [regex]::Escape($tok), '<token>').Trim()) } }
  $un = Join-Path $App 'uninstall.exe'
  if (Test-Path $un) {
    # /UPDATE: files and the uninstall key only; no shortcut, AppUserModelId, Run value or data clean-up.
    # _?= runs it in place and waits (otherwise it copies itself to %TEMP% and returns at once).
    $u = Start-Process -FilePath $un -ArgumentList '/S', '/UPDATE', ('_?=' + $App) -PassThru -Wait
    Say ("uninstaller exit code " + $u.ExitCode)
  }
  Say ("after uninstall: " + (Reg-State))
  Remove-Item -Recurse -Force $T -ErrorAction SilentlyContinue
  Say ("temp folder removed: " + (-not (Test-Path $T)))
  # Put the owner's registration back exactly as exported.
  Remove-Item $UK -Recurse -ErrorAction SilentlyContinue
  # reg.exe prints its success line on stderr; under ErrorActionPreference=Stop that ended the first run after the first
  # import (the manufacturer key was then imported by hand). Continue for these two native calls.
  $ErrorActionPreference = 'Continue'
  & reg.exe import (Join-Path $Backup 'uninstall-PocketRocket.reg') 2>$null; Say ("reg import uninstall key rc=" + $LASTEXITCODE)
  & reg.exe import (Join-Path $Backup 'manufacturer-key.reg') 2>$null; Say ("reg import manufacturer key rc=" + $LASTEXITCODE)
  $ErrorActionPreference = 'Stop'
  Say ("restored: " + (Reg-State))
  Say ("owner's PocketRocket.exe unchanged: " + ((Get-FileHash (Join-Path $owner 'PocketRocket.exe')).Hash -eq $ownerExe) + "; uninstall.exe present: " + (Test-Path (Join-Path $owner 'uninstall.exe')))
  foreach ($lnk in (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\PocketRocket.lnk'), (Join-Path $env:USERPROFILE 'Desktop\PocketRocket.lnk')) {
    Say ("shortcut " + (Split-Path -Leaf (Split-Path -Parent $lnk)) + "\PocketRocket.lnk -> " + $(if (Test-Path $lnk) { (New-Object -ComObject WScript.Shell).CreateShortcut($lnk).TargetPath } else { '(missing)' }))
  }
  Say ("PocketRocket uninstall entries now: " + @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -eq 'PocketRocket' }).Count)
}
