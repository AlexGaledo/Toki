# Item 3: the real tray icon's menu, through Windows UI Automation.
#   tray_uia.ps1 -Find                        read-only: where the Toki icon is (taskbar or overflow)
#   tray_uia.ps1 -Click "Open your server"     open the icon's menu and invoke that item
# The icon's menu opens on a right click (show_menu_on_left_click(false)), so the icon gets one synthesized right click at
# its UIA bounding box. The menu item is then invoked through UIA (InvokePattern), not clicked by position.
param([switch]$Find, [string]$Click)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Mouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  public static void RightClick(int x, int y) { SetCursorPos(x, y); mouse_event(0x0008, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0010, 0, 0, 0, UIntPtr.Zero); }
}
"@
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$root = $AE::RootElement
function Stamp($s) { (Get-Date -Format 'HH:mm:ss.fff') + ' ' + $s }
function Find-Toki {
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  foreach ($cls in 'Shell_TrayWnd', 'TopLevelWindowForOverflowXamlIsland', 'NotifyIconOverflowWindow') {
    $wins = $root.FindAll($TS::Children, (New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, $cls)))
    foreach ($w in $wins) {
      foreach ($b in $w.FindAll($TS::Descendants, $cond)) {
        if ($b.Current.Name -match '^Toki\b') { return [pscustomobject]@{ Where = $cls; El = $b } }
      }
    }
  }
  return $null
}
function Find-Overflow {
  $tb = $root.FindFirst($TS::Children, (New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'Shell_TrayWnd')))
  foreach ($b in $tb.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($b.Current.Name -match 'Show hidden icons|hidden icons') { return $b }
  }
  return $null
}

$hit = Find-Toki
if (-not $hit) {
  $chev = Find-Overflow
  Stamp ("Toki icon not on the taskbar; overflow chevron: " + $(if ($chev) { $chev.Current.Name } else { '(not found)' }))
  if ($chev) {
    $chev.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds 800
    $hit = Find-Toki
  }
}
if (-not $hit) { Stamp 'Toki tray icon: NOT FOUND through UIA'; exit 2 }
$r = $hit.El.Current.BoundingRectangle
Stamp ("Toki tray icon: name='" + $hit.El.Current.Name + "' in " + $hit.Where + " at " + [int]$r.X + "," + [int]$r.Y + " " + [int]$r.Width + "x" + [int]$r.Height + " patterns=" + (($hit.El.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) -join ','))
if ($Find) { exit 0 }

[Mouse]::RightClick([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
Stamp 'right click sent to the icon'
$menuItem = $null
$deadline = (Get-Date).AddSeconds(5)
$miCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)
while (-not $menuItem -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 250
  foreach ($m in $root.FindAll($TS::Children, (New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, '#32768')))) {
    $items = $m.FindAll($TS::Descendants, $miCond)
    Stamp ('menu #32768 items: ' + (($items | ForEach-Object { $_.Current.Name }) -join ' | '))
    $menuItem = $items | Where-Object { $_.Current.Name -eq $Click } | Select-Object -First 1
  }
}
if (-not $menuItem) {
  Stamp ("menu item '" + $Click + "' NOT FOUND through UIA; closing any open menu with Escape")
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  exit 3
}
$menuItem.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Stamp ("invoked '" + $Click + "' through UIA InvokePattern")
