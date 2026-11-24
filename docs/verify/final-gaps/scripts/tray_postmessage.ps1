# I2: the real tray's "Open your server", with no synthesized mouse input.
# tray-icon 0.25.1 (src/platform_impl/windows/mod.rs) opens the tray menu when its hidden "tray_icon_app" window gets
# WM_USER_TRAYICON (6002) with lParam = WM_RBUTTONUP: show_tray_menu -> TrackPopupMenu at GetCursorPos. So this posts
# that message to Toki's own tray window, finds Toki's #32768 popup menu, and invokes "Open your server" through
# UIA InvokePattern. The mouse is never moved and nothing is clicked.
#   powershell -File tray_postmessage.ps1 [-Mode probe|open] [-Try <n>]
# probe: windows, DPI and the window's URL only (read-only). open: post the message and invoke the item.
param([string]$Mode = 'probe', [int]$Try = 1)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public static List<IntPtr> Of(uint pid) {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid) r.Add(h); return true; }, IntPtr.Zero);
    return r;
  }
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Txt(IntPtr h) { var s = new StringBuilder(256); GetWindowText(h, s, 256); return s.ToString(); }
}
'@
function Log($s) { Write-Output ((Get-Date).ToString('HH:mm:ss.fff') + ' ' + $s) }
function Cut($u) { if ($u) { ($u -replace '#.*', '#<fragment>') } else { '(none)' } }

$app = Get-Process PocketRocket -ErrorAction Stop | Select-Object -First 1
Log ("PocketRocket pid " + $app.Id + ", started " + $app.StartTime.ToString('HH:mm:ss'))
$wins = [W]::Of([uint32]$app.Id) | ForEach-Object { [pscustomobject]@{ h = $_; cls = [W]::Cls($_); txt = [W]::Txt($_); vis = [W]::IsWindowVisible($_) } }
$tray = @($wins | Where-Object { $_.cls -eq 'tray_icon_app' })
$main = $wins | Where-Object { $_.vis -and $_.txt -like 'Toki*' } | Select-Object -First 1
Log ("tray_icon_app windows: " + ($tray | ForEach-Object { '0x{0:X}' -f [int64]$_.h }) -join ', ')
Log ("main window: 0x{0:X} '{1}', GetDpiForWindow={2} ({3}%)" -f [int64]$main.h, $main.txt, [W]::GetDpiForWindow($main.h), [math]::Round([W]::GetDpiForWindow($main.h) / 96 * 100))

function Get-PageUrl {
  # Read-only: the WebView2 document's UIA Value is its URL. The fragment is cut before it is shown.
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($main.h)
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
  $doc = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if (-not $doc) { return $null }
  $vp = $null
  if ($doc.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { return $vp.Current.Value }
  return $null
}
function Get-Tunnel { @(Get-NetTCPConnection -State Listen -LocalPort 7790 -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalAddress + ':7790 pid ' + $_.OwningProcess + ' (' + (Get-Process -Id $_.OwningProcess).ProcessName + ')' }) }

Log ("window URL (UIA document value): " + (Cut (Get-PageUrl)))
Log ("7790 listeners: " + ((Get-Tunnel) -join '; '))
if ($Mode -ne 'open') { exit 0 }
if ($tray.Count -ne 1) { throw "expected one tray_icon_app window, found $($tray.Count)" }

$pt = New-Object W+POINT; [void][W]::GetCursorPos([ref]$pt)
Log ("try $Try. cursor at " + $pt.X + ',' + $pt.Y + ' (not moved). PostMessage(tray, WM_USER_TRAYICON=6002, 0, WM_RBUTTONUP=0x0205)')
$before = @([W]::Of([uint32]$app.Id) | Where-Object { [W]::Cls($_) -eq '#32768' -and [W]::IsWindowVisible($_) })
[void][W]::PostMessage($tray[0].h, 6002, [IntPtr]::Zero, [IntPtr]0x0205)
$menu = $null; $t = Get-Date
while (((Get-Date) - $t).TotalMilliseconds -lt 3000 -and -not $menu) {
  $menu = [W]::Of([uint32]$app.Id) | Where-Object { [W]::Cls($_) -eq '#32768' -and [W]::IsWindowVisible($_) -and $before -notcontains $_ } | Select-Object -First 1
  if (-not $menu) { Start-Sleep -Milliseconds 100 }
}
if (-not $menu) { Log 'no #32768 menu from Toki within 3 s'; exit 2 }
Log ("Toki's menu opened: #32768 0x{0:X} after {1} ms" -f [int64]$menu, [int]((Get-Date) - $t).TotalMilliseconds)
$el = [System.Windows.Automation.AutomationElement]::FromHandle($menu)
$items = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)))
Log ("menu items: " + (($items | ForEach-Object { $_.Current.Name }) -join ' | '))
$item = $items | Where-Object { $_.Current.Name -eq 'Open your server' } | Select-Object -First 1
if (-not $item) { Log 'no "Open your server" item'; exit 3 }
$ip = $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$t1 = Get-Date
$ip.Invoke()
Log 'invoked "Open your server" (InvokePattern)'
$url = $null; $tun = @()
while (((Get-Date) - $t1).TotalSeconds -lt 60) {
  $tun = Get-Tunnel; $url = Get-PageUrl
  if ($tun.Count -gt 0 -and $url -like 'http://127.0.0.1:7790/*') { break }
  Start-Sleep -Milliseconds 250
}
Log ("after {0:N1} s: 7790 listeners: {1}" -f ((Get-Date) - $t1).TotalSeconds, ($tun -join '; '))
Log ("window URL (UIA document value): " + (Cut $url))
$pt2 = New-Object W+POINT; [void][W]::GetCursorPos([ref]$pt2)
Log ("cursor at " + $pt2.X + ',' + $pt2.Y)
