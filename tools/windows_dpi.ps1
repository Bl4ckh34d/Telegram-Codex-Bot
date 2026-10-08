function Ensure-PerMonitorDpi {
  if (-not ("Aidolon.DpiNative" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace Aidolon {
  public static class DpiNative {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  }
}
"@
  }
  # Set the current thread before WinForms caches monitor bounds or GDI captures.
  # This keeps screen bounds, cursor coordinates and bitmap pixels in one space.
  $previous = [Aidolon.DpiNative]::SetThreadDpiAwarenessContext([IntPtr](-4))
  if ($previous -eq [IntPtr]::Zero) {
    $previous = [Aidolon.DpiNative]::SetThreadDpiAwarenessContext([IntPtr](-3))
  }
  if ($previous -eq [IntPtr]::Zero) {
    throw "Per-monitor DPI awareness could not be enabled; refusing a scaled/cropped capture."
  }
}
