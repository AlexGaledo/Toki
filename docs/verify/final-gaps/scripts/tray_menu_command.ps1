# I2: the real tray menu's "Open your server", with no mouse input. Opens Toki's own tray menu (WM_USER_TRAYICON + WM_RBUTTONUP
# to its tray_icon_app window), reads the real HMENU (MN_GETHMENU), finds "Open your server" by its text, closes the
# popup and sends that item's WM_COMMAND to the owner window, which is what a real pick sends. Then waits for 7790.
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class M {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr m);
  [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr m, int i);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetMenuString(IntPtr m, uint id, StringBuilder s, int n, uint f);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
  public static List<IntPtr> Of(uint pid, string cls) { var r = new List<IntPtr>(); EnumWindows((h,l)=>{uint p; GetWindowThreadProcessId(h,out p); var s=new StringBuilder(64); GetClassName(h,s,64); if(p==pid && s.ToString()==cls) r.Add(h); return true;}, IntPtr.Zero); return r; }
  public static List<IntPtr> Menus() { var r = new List<IntPtr>(); EnumWindows((h,l)=>{var s=new StringBuilder(64); GetClassName(h,s,64); if(s.ToString()=="#32768") r.Add(h); return true;}, IntPtr.Zero); return r; }
}
'@
$ts = { (Get-Date).ToString('HH:mm:ss.fff') }
$toki = (Get-Process PocketRocket | Select-Object -First 1).Id
$tray = [M]::Of($toki, 'tray_icon_app') | Select-Object -First 1
"$(& $ts) tray window $tray"
[void][M]::PostMessage($tray, 6002, [IntPtr]::Zero, [IntPtr]0x0205)
$menuWin = $null; $t0 = Get-Date
while (-not $menuWin -and ((Get-Date) - $t0).TotalMilliseconds -lt 3000) { Start-Sleep -Milliseconds 50; foreach ($h in [M]::Menus()) { $p=0; [void][M]::GetWindowThreadProcessId($h,[ref]$p); if ($p -eq $toki) { $menuWin = $h } } }
if (-not $menuWin) { "no menu window"; exit 1 }
$hmenu = [M]::SendMessage($menuWin, 0x01E1, [IntPtr]::Zero, [IntPtr]::Zero)
$n = [M]::GetMenuItemCount($hmenu); "$(& $ts) menu open, HMENU $hmenu, $n items"
$target = $null
for ($i = 0; $i -lt $n; $i++) { $id = [M]::GetMenuItemID($hmenu, $i); $sb = New-Object Text.StringBuilder 128; [void][M]::GetMenuString($hmenu, [uint32]$i, $sb, 128, 0x400); "  [$i] id=$id '$($sb.ToString())'"; if ($sb.ToString() -eq 'Open your server') { $target = $id } }
if ($null -eq $target) { [void][M]::PostMessage($menuWin, 0x0100, [IntPtr]0x1B, [IntPtr]::Zero); "item not found; closed menu"; exit 1 }
# Close the popup, then send the item's command to the owner, as a real pick does.
[void][M]::PostMessage($menuWin, 0x0100, [IntPtr]0x1B, [IntPtr]::Zero)
Start-Sleep -Milliseconds 300
[void][M]::PostMessage($tray, 0x0111, [IntPtr]$target, [IntPtr]::Zero)
"$(& $ts) sent WM_COMMAND id=$target ('Open your server') to the tray window"
$t1 = Get-Date
while (((Get-Date) - $t1).TotalSeconds -lt 40) { Start-Sleep -Milliseconds 500; $l = netstat -ano | Select-String '127.0.0.1:7790 .*LISTENING'; if ($l) { "$(& $ts) 7790 listening after $([math]::Round(((Get-Date)-$t1).TotalSeconds,1)) s: $($l.Line.Trim())"; break } }
