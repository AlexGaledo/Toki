// A stand-in blender.exe that crashes at once (docs/verify/ui-gaps). It is not Blender and opens no window.
// `--version` answers like Blender, so detection reads a version; anything else prints a few lines and exits 3,
// which BlenderHost counts as an unexpected exit (a crash). Build:
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /out:blender.exe crash_stub.cs
using System;
class CrashStub {
  static int Main(string[] args) {
    if (Array.IndexOf(args, "--version") >= 0) {
      Console.WriteLine("Blender 9.9.0 (crash stub for the ui-gaps verify run)");
      return 0;
    }
    Console.WriteLine("Read prefs: (factory startup)");
    Console.Error.WriteLine("crash stub: args " + string.Join(" ", args).Length + " chars");
    Console.Error.WriteLine("EXCEPTION_ACCESS_VIOLATION (simulated by the ui-gaps crash stub)");
    return 3;
  }
}
