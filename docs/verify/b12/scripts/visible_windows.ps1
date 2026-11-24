# Lists the top-level windows of one process and whether each is visible (IsWindowVisible).
# Usage: powershell -NoProfile -File visible_windows.ps1 <pid>
param([int]$TargetPid)
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class TokiWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static List<string> Of(uint target) {
    var found = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == target) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256); found.Add((IsWindowVisible(h) ? "VISIBLE " : "hidden ") + "'" + sb + "'"); }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$w = [TokiWin]::Of([uint32]$TargetPid)
"windows of pid ${TargetPid}: $($w.Count); visible: $(@($w | Where-Object { $_ -like 'VISIBLE*' }).Count)"
$w
