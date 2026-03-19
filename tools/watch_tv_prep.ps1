param(
  [string]$SunshineCommand = "C:\Users\ROG\AppData\Local\Apollo\StartSunshine.cmd",
  [string]$TvHost = "",
  [int]$TvPort = 5555,
  [string]$TvSerial = "",
  [int]$SunshineWaitMs = 1200,
  [int]$TvPowerWaitMs = 700,
  [int]$ArtemisWaitMs = 700,
  [int]$ArtemisLoadWaitMs = 0,
  [int]$StreamDetectTimeoutMs = 12000,
  [int]$StreamDetectPollMs = 500,
  [bool]$PreferReuseExistingConnection = $true,
  [string]$PreferredPcName = "ARCU",
  [switch]$SkipArtemisKeySequence,
  [switch]$AllowUnverifiedStream,
  [string]$BrowserProcess = "firefox",
  [switch]$UseIsolatedFirefoxProfile,
  [int]$BrowserSettleMs = 450,
  [string]$MoveDirection = "Right",
  [string]$FirstUrl = "https://s.to",
  [string]$SecondUrl = "https://sflix.ps",
  [string]$PreferredAudioDevice = "Bigscreen",
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Convert-FromJsonLine {
  param([string]$Raw)
  $text = [string]$Raw
  if ([string]::IsNullOrWhiteSpace($text)) {
    throw "Command returned no output."
  }
  $lines = @($text -split "(`r`n|`n|`r)" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    $line = [string]$lines[$i]
    if ($line.TrimStart().StartsWith("{")) {
      try {
        return ($line | ConvertFrom-Json -ErrorAction Stop)
      } catch {}
    }
  }
  throw "Could not find JSON output in command response."
}

function Invoke-JsonScript {
  param(
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [Parameter(Mandatory = $true)][hashtable]$Arguments
  )
  if ($DryRun.IsPresent) {
    return [pscustomobject]@{
      ok = $true
      action = "dryrun"
      result = @{
        script = $ScriptPath
        args = $Arguments
      }
    }
  }
  $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ScriptPath)
  foreach ($key in @($Arguments.Keys)) {
    $val = $Arguments[$key]
    if ($null -eq $val) { continue }
    if ($val -is [switch]) {
      if (-not $val.IsPresent) { continue }
      $argList += "-$key"
      continue
    }
    if ($val -is [bool]) {
      if (-not $val) { continue }
      $argList += "-$key"
      continue
    }
    if ($val -is [string] -and [string]::IsNullOrWhiteSpace([string]$val)) { continue }
    $argList += "-$key"
    $argList += [string]$val
  }

  # Run in a child process so Console.WriteLine output from tool scripts is captured.
  $raw = (& powershell @argList 2>&1 | Out-String)
  return Convert-FromJsonLine -Raw $raw
}

function Invoke-Ui {
  param([Parameter(Mandatory = $true)][hashtable]$Arguments)
  $resp = Invoke-JsonScript -ScriptPath $script:UiScript -Arguments $Arguments
  if (-not $resp.ok) {
    $msg = [string]$resp.error
    if ([string]::IsNullOrWhiteSpace($msg)) { $msg = "UI automation action failed." }
    throw $msg
  }
  return $resp
}

function Get-ScreenCountSafe {
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    return [System.Windows.Forms.Screen]::AllScreens.Count
  } catch {
    return 0
  }
}

function Get-ScreenIndexByHandleSafe {
  param([string]$HandleHex)
  try {
    if ([string]::IsNullOrWhiteSpace([string]$HandleHex)) { return -1 }
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $trimmed = ([string]$HandleHex).Trim()
    if (-not $trimmed.StartsWith("0x")) { return -1 }
    $raw = [Convert]::ToInt64($trimmed.Substring(2), 16)
    $ptr = [IntPtr]::new($raw)
    $screen = [System.Windows.Forms.Screen]::FromHandle($ptr)
    if ($null -eq $screen) { return -1 }
    $all = [System.Windows.Forms.Screen]::AllScreens
    for ($i = 0; $i -lt $all.Count; $i++) {
      if ($all[$i].DeviceName -eq $screen.DeviceName) {
        return [int]$i
      }
    }
    return -1
  } catch {
    return -1
  }
}

function Ensure-WindowMoveTypes {
  if ("AidolonWindowNative" -as [type]) { return }
  $src = @"
using System;
using System.Runtime.InteropServices;
public static class AidolonWindowNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
  Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop | Out-Null
}

function Maximize-WindowSafe {
  param([string]$HandleHex)
  try {
    if ([string]::IsNullOrWhiteSpace([string]$HandleHex)) { return $false }
    Ensure-WindowMoveTypes
    $trimmed = ([string]$HandleHex).Trim()
    if (-not $trimmed.StartsWith("0x")) { return $false }
    $raw = [Convert]::ToInt64($trimmed.Substring(2), 16)
    $ptr = [IntPtr]::new($raw)
    # SW_MAXIMIZE = 3
    return [bool][AidolonWindowNative]::ShowWindow($ptr, 3)
  } catch {
    return $false
  }
}

function Move-WindowToAdjacentScreenSafe {
  param(
    [string]$HandleHex,
    [ValidateSet("Left", "Right")][string]$Direction = "Right"
  )
  $result = [ordered]@{
    moved = $false
    before = -1
    after = -1
  }
  try {
    if ([string]::IsNullOrWhiteSpace([string]$HandleHex)) {
      return $result
    }
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    Ensure-WindowMoveTypes

    $trimmed = ([string]$HandleHex).Trim()
    if (-not $trimmed.StartsWith("0x")) {
      return $result
    }
    $raw = [Convert]::ToInt64($trimmed.Substring(2), 16)
    $ptr = [IntPtr]::new($raw)

    $screens = [System.Windows.Forms.Screen]::AllScreens
    if ($screens.Count -lt 2) {
      $singleIdx = Get-ScreenIndexByHandleSafe -HandleHex $HandleHex
      $result.before = $singleIdx
      $result.after = $singleIdx
      return $result
    }

    $beforeIdx = Get-ScreenIndexByHandleSafe -HandleHex $HandleHex
    if ($beforeIdx -lt 0) {
      return $result
    }
    $result.before = $beforeIdx

    $targetIdx = if ($Direction -eq "Left") { $beforeIdx - 1 } else { $beforeIdx + 1 }
    if ($targetIdx -lt 0) { $targetIdx = $screens.Count - 1 }
    if ($targetIdx -ge $screens.Count) { $targetIdx = 0 }
    $targetArea = $screens[$targetIdx].WorkingArea

    $rect = New-Object AidolonWindowNative+RECT
    if (-not [AidolonWindowNative]::GetWindowRect($ptr, [ref]$rect)) {
      return $result
    }

    $width = [Math]::Max(900, $rect.Right - $rect.Left)
    $height = [Math]::Max(640, $rect.Bottom - $rect.Top)
    $width = [Math]::Min($width, $targetArea.Width)
    $height = [Math]::Min($height, $targetArea.Height)

    $x = [int]($targetArea.X + [Math]::Max(0, ($targetArea.Width - $width) / 2))
    $y = [int]($targetArea.Y + [Math]::Max(0, ($targetArea.Height - $height) / 2))
    $ok = [AidolonWindowNative]::MoveWindow($ptr, $x, $y, $width, $height, $true)
    if (-not $ok) {
      return $result
    }

    Start-Sleep -Milliseconds 80
    $afterIdx = Get-ScreenIndexByHandleSafe -HandleHex $HandleHex
    $result.after = $afterIdx
    $result.moved = ($afterIdx -ge 0 -and $afterIdx -ne $beforeIdx)
    return $result
  } catch {
    return $result
  }
}

function Invoke-SunshineStart {
  param([string]$CommandText)
  if ($DryRun.IsPresent) { return }
  if ([string]::IsNullOrWhiteSpace($CommandText)) {
    throw "Sunshine command is empty."
  }
  $trimmed = $CommandText.Trim()
  if (-not (Test-Path -LiteralPath $trimmed)) {
    throw "Sunshine launcher file was not found."
  }
  $ext = [IO.Path]::GetExtension($trimmed).ToLowerInvariant()
  if ($ext -eq ".ps1") {
    Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $trimmed) -WindowStyle Hidden | Out-Null
    return
  }
  if ($ext -eq ".cmd" -or $ext -eq ".bat") {
    Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "`"$trimmed`"") -WindowStyle Hidden | Out-Null
    return
  }
  Start-Process -FilePath $trimmed -WindowStyle Hidden | Out-Null
}

function Test-SunshineRunning {
  $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match "sunshine" })
  return ($procs.Count -gt 0)
}

function Stop-SunshineProcesses {
  if ($DryRun.IsPresent) { return 0 }
  $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match "sunshine" })
  if ($procs.Count -eq 0) {
    return 0
  }
  foreach ($proc in $procs) {
    Stop-Process -Id $proc.Id -Force -ErrorAction Stop
  }
  $deadline = [DateTime]::UtcNow.AddMilliseconds(5000)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Test-SunshineRunning)) {
      return $procs.Count
    }
    Start-Sleep -Milliseconds 200
  }
  throw "Sunshine was running but could not be stopped cleanly."
}

function Ensure-AudioPolicyTypes {
  if ("AidolonAudioPolicy" -as [type]) { return }
  $src = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class AidolonAudioPolicy {
  private const uint DEVICE_STATE_ACTIVE = 0x00000001;
  private static readonly Guid PKEY_DEVICE_FRIENDLYNAME_FMTID = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
  private const int PKEY_DEVICE_FRIENDLYNAME_PID = 14;
  private const int VT_LPWSTR = 31;

  public static List<string> ListPlaybackNames() {
    var items = EnumeratePlaybackDevices();
    var names = new List<string>();
    foreach (var item in items) names.Add(item.Name);
    return names;
  }

  public static bool SetDefaultPlaybackByName(string preferredName, out string matchedName, out string matchedId, out string error) {
    matchedName = string.Empty;
    matchedId = string.Empty;
    error = string.Empty;
    if (string.IsNullOrWhiteSpace(preferredName)) {
      error = "Preferred audio device name is empty.";
      return false;
    }

    var devices = EnumeratePlaybackDevices();
    DeviceInfo match = null;
    foreach (var item in devices) {
      if (string.Equals(item.Name, preferredName, StringComparison.OrdinalIgnoreCase)) {
        match = item;
        break;
      }
    }
    if (match == null) {
      foreach (var item in devices) {
        if (item.Name != null && item.Name.IndexOf(preferredName, StringComparison.OrdinalIgnoreCase) >= 0) {
          match = item;
          break;
        }
      }
    }
    if (match == null) {
      var normalizedPreferred = NormalizeForMatch(preferredName);
      if (!string.IsNullOrEmpty(normalizedPreferred)) {
        foreach (var item in devices) {
          var normalizedName = NormalizeForMatch(item.Name);
          if (!string.IsNullOrEmpty(normalizedName) && normalizedName.Contains(normalizedPreferred)) {
            match = item;
            break;
          }
        }
      }
    }
    if (match == null) {
      error = "Audio device not found.";
      return false;
    }

    object raw = null;
    IPolicyConfig policy = null;
    try {
      raw = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9"), true));
      policy = (IPolicyConfig)raw;
      policy.SetDefaultEndpoint(match.Id, ERole.eConsole);
      policy.SetDefaultEndpoint(match.Id, ERole.eMultimedia);
      policy.SetDefaultEndpoint(match.Id, ERole.eCommunications);
      matchedName = match.Name ?? string.Empty;
      matchedId = match.Id ?? string.Empty;
      return true;
    } catch (Exception ex) {
      error = ex.Message;
      return false;
    } finally {
      if (policy != null && Marshal.IsComObject(policy)) Marshal.ReleaseComObject(policy);
      if (raw != null && Marshal.IsComObject(raw)) Marshal.ReleaseComObject(raw);
    }
  }

  private static List<DeviceInfo> EnumeratePlaybackDevices() {
    var result = new List<DeviceInfo>();
    IMMDeviceEnumerator enumerator = null;
    IMMDeviceCollection coll = null;
    try {
      enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
      enumerator.EnumAudioEndpoints(EDataFlow.eRender, DEVICE_STATE_ACTIVE, out coll);
      if (coll == null) return result;
      uint count;
      coll.GetCount(out count);
      for (uint i = 0; i < count; i++) {
        IMMDevice dev = null;
        IPropertyStore props = null;
        PropVariant value = null;
        try {
          coll.Item(i, out dev);
          if (dev == null) continue;
          string id;
          dev.GetId(out id);
          dev.OpenPropertyStore(0, out props);
          if (props == null) continue;
          var key = new PropertyKey(PKEY_DEVICE_FRIENDLYNAME_FMTID, PKEY_DEVICE_FRIENDLYNAME_PID);
          value = new PropVariant();
          props.GetValue(ref key, value);
          string name = value.GetString();
          result.Add(new DeviceInfo { Id = id ?? string.Empty, Name = name ?? string.Empty });
        } finally {
          if (value != null) value.Dispose();
          if (props != null && Marshal.IsComObject(props)) Marshal.ReleaseComObject(props);
          if (dev != null && Marshal.IsComObject(dev)) Marshal.ReleaseComObject(dev);
        }
      }
      return result;
    } finally {
      if (coll != null && Marshal.IsComObject(coll)) Marshal.ReleaseComObject(coll);
      if (enumerator != null && Marshal.IsComObject(enumerator)) Marshal.ReleaseComObject(enumerator);
    }
  }

  private class DeviceInfo {
    public string Id;
    public string Name;
  }

  private static string NormalizeForMatch(string value) {
    if (string.IsNullOrWhiteSpace(value)) return string.Empty;
    var chars = value.ToCharArray();
    var outChars = new char[chars.Length];
    int idx = 0;
    for (int i = 0; i < chars.Length; i++) {
      var c = chars[i];
      if (char.IsLetterOrDigit(c)) {
        outChars[idx++] = char.ToLowerInvariant(c);
      }
    }
    return idx == 0 ? string.Empty : new string(outChars, 0, idx);
  }

  [ComImport]
  [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  private class MMDeviceEnumeratorComObject {}

  private enum EDataFlow {
    eRender = 0,
    eCapture = 1,
    eAll = 2
  }

  private enum ERole {
    eConsole = 0,
    eMultimedia = 1,
    eCommunications = 2
  }

  [ComImport]
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDeviceEnumerator {
    int NotImpl1();
    [PreserveSig]
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
    [PreserveSig]
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    [PreserveSig]
    int EnumAudioEndpoints(EDataFlow dataFlow, uint stateMask, out IMMDeviceCollection devices);
  }

  [ComImport]
  [Guid("0BD7A1BE-7A1A-44DB-8397-C0A0F5C5A4E5")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDeviceCollection {
    [PreserveSig]
    int GetCount(out uint pcDevices);
    [PreserveSig]
    int Item(uint nDevice, out IMMDevice device);
  }

  [ComImport]
  [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDevice {
    [PreserveSig]
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object interfacePointer);
    [PreserveSig]
    int OpenPropertyStore(int stgmAccess, out IPropertyStore properties);
    [PreserveSig]
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig]
    int GetState(out int state);
  }

  [ComImport]
  [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IPropertyStore {
    [PreserveSig]
    int GetCount(out uint propCount);
    [PreserveSig]
    int GetAt(uint propertyIndex, out PropertyKey key);
    [PreserveSig]
    int GetValue(ref PropertyKey key, [Out] PropVariant pv);
    [PreserveSig]
    int SetValue(ref PropertyKey key, [In] PropVariant pv);
    [PreserveSig]
    int Commit();
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct PropertyKey {
    public Guid fmtid;
    public int pid;
    public PropertyKey(Guid format, int propertyId) {
      fmtid = format;
      pid = propertyId;
    }
  }

  [StructLayout(LayoutKind.Explicit)]
  private sealed class PropVariant : IDisposable {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] private IntPtr pointerValue;

    public string GetString() {
      if (vt == VT_LPWSTR && pointerValue != IntPtr.Zero) {
        return Marshal.PtrToStringUni(pointerValue);
      }
      return string.Empty;
    }

    public void Dispose() {
      try {
        PropVariantClear(this);
      } catch {}
      GC.SuppressFinalize(this);
    }

    ~PropVariant() {
      Dispose();
    }
  }

  [DllImport("ole32.dll")]
  private static extern int PropVariantClear([In, Out] PropVariant pvar);

  [ComImport]
  [Guid("f8679f50-850a-41cf-9c72-430f290290c8")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IPolicyConfig {
    int GetMixFormat();
    int GetDeviceFormat();
    int SetDeviceFormat();
    int GetProcessingPeriod();
    int SetProcessingPeriod();
    int GetShareMode();
    int SetShareMode();
    int GetPropertyValue();
    int SetPropertyValue();
    int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, ERole role);
    int SetEndpointVisibility();
  }
}
"@
  Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop | Out-Null
}

function Set-PreferredPlaybackDevice {
  param([string]$DeviceName)
  $result = [ordered]@{
    attempted = $false
    changed = $false
    target = $DeviceName
    matched = ""
    warning = ""
  }
  if ([string]::IsNullOrWhiteSpace([string]$DeviceName)) {
    $result.warning = "Preferred audio device is empty; skipping audio switch."
    return $result
  }
  if ($DryRun.IsPresent) {
    $result.attempted = $true
    $result.changed = $true
    return $result
  }
  try {
    Ensure-AudioPolicyTypes
    $matchedName = ""
    $matchedId = ""
    $err = ""
    $ok = [AidolonAudioPolicy]::SetDefaultPlaybackByName($DeviceName, [ref]$matchedName, [ref]$matchedId, [ref]$err)
    $result.attempted = $true
    if ($ok) {
      $result.changed = $true
      $result.matched = [string]$matchedName
      return $result
    }
    $result.warning = if ([string]::IsNullOrWhiteSpace([string]$err)) { "Audio switch failed." } else { [string]$err }
    try {
      $available = [AidolonAudioPolicy]::ListPlaybackNames()
      if ($available.Count -gt 0) {
        $result.available = @($available)
      }
    } catch {}
    return $result
  } catch {
    $result.attempted = $true
    $result.warning = [string]$_.Exception.Message
    return $result
  }
}

function Resolve-AdbTarget {
  if ($TvSerial) { return $TvSerial }
  if ($TvHost) {
    $endpoint = "$TvHost`:$TvPort"
    & adb connect $endpoint | Out-Null
    return $endpoint
  }
  $envHost = ([string]$env:AIDOLON_TV_HOST).Trim()
  if ($envHost) {
    $endpoint = "$envHost`:$TvPort"
    & adb connect $endpoint | Out-Null
    return $endpoint
  }
  return ""
}

function Send-AdbKey {
  param(
    [string]$Target,
    [int]$Code
  )
  if ($DryRun.IsPresent) { return }
  if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    throw "adb is not installed or not in PATH."
  }
  $args = @()
  if ($Target) { $args += @("-s", $Target) }
  $args += @("shell", "input", "keyevent", [string]$Code)
  & adb @args | Out-Null
}

function Invoke-AdbOutput {
  param(
    [string]$Target,
    [Parameter(Mandatory = $true)][string[]]$Args
  )
  if ($DryRun.IsPresent) { return "" }
  if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    throw "adb is not installed or not in PATH."
  }
  $allArgs = @()
  if ($Target) { $allArgs += @("-s", $Target) }
  $allArgs += $Args
  return (& adb @allArgs 2>&1 | Out-String)
}

function Send-AdbTap {
  param(
    [string]$Target,
    [int]$X,
    [int]$Y
  )
  if ($DryRun.IsPresent) { return }
  if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    throw "adb is not installed or not in PATH."
  }
  $args = @()
  if ($Target) { $args += @("-s", $Target) }
  $args += @("shell", "input", "tap", [string]$X, [string]$Y)
  & adb @args | Out-Null
}

function Get-ForegroundComponent {
  param([string]$Target)
  if ($DryRun.IsPresent) {
    return [pscustomobject]@{
      package = "de.grill2010.artemis"
      activity = "de.grill2010.artemis.MainActivity"
    }
  }

  $windowDump = Invoke-AdbOutput -Target $Target -Args @("shell", "dumpsys", "window", "windows")
  $m = [regex]::Match([string]$windowDump, "mCurrentFocus.+?\s([A-Za-z0-9\._]+)\/([A-Za-z0-9\._$]+)")
  if ($m.Success) {
    return [pscustomobject]@{
      package = ([string]$m.Groups[1].Value).Trim()
      activity = ([string]$m.Groups[2].Value).Trim()
    }
  }

  $activityDump = Invoke-AdbOutput -Target $Target -Args @("shell", "dumpsys", "activity", "activities")
  $m2 = [regex]::Match([string]$activityDump, "mResumedActivity.+?\s([A-Za-z0-9\._]+)\/([A-Za-z0-9\._$]+)")
  if ($m2.Success) {
    return [pscustomobject]@{
      package = ([string]$m2.Groups[1].Value).Trim()
      activity = ([string]$m2.Groups[2].Value).Trim()
    }
  }

  return [pscustomobject]@{
    package = ""
    activity = ""
  }
}

function Get-ForegroundPackage {
  param([string]$Target)
  return [string](Get-ForegroundComponent -Target $Target).package
}

function Test-ArtemisPackage {
  param([string]$PackageName)
  if ([string]::IsNullOrWhiteSpace([string]$PackageName)) { return $false }
  $known = @("de.grill2010.artemis", "com.limelight.noir", "com.limelight")
  return ($known -contains ([string]$PackageName).Trim())
}

function Get-BrowserWindowHandles {
  param([string]$ProcessName)
  $handles = @()
  if ($DryRun.IsPresent) { return $handles }
  $needle = ([string]$ProcessName).Trim().ToLowerInvariant()
  if ($needle.EndsWith(".exe")) {
    $needle = $needle.Substring(0, $needle.Length - 4)
  }
  if ([string]::IsNullOrWhiteSpace($needle)) {
    return $handles
  }
  try {
    $resp = Invoke-Ui -Arguments @{
      Action = "windows"
      Limit = 80
    }
    $wins = @($resp.result.windows)
    foreach ($w in $wins) {
      $proc = ([string]$w.process).Trim().ToLowerInvariant()
      if ($proc -ne $needle) { continue }
      $h = ([string]$w.handle).Trim()
      if ([string]::IsNullOrWhiteSpace($h)) { continue }
      $handles += $h
    }
  } catch {}
  return @($handles | Sort-Object -Unique)
}

function Wait-NewBrowserWindowHandle {
  param(
    [string]$ProcessName,
    [string[]]$BeforeHandles,
    [int]$TimeoutMs = 7000
  )
  if ($DryRun.IsPresent) { return "" }
  $baseline = @($BeforeHandles | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Sort-Object -Unique)
  $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(300, $TimeoutMs))
  while ([DateTime]::UtcNow -lt $deadline) {
    $now = @(Get-BrowserWindowHandles -ProcessName $ProcessName)
    foreach ($h in $now) {
      if ($baseline -notcontains $h) {
        return [string]$h
      }
    }
    Start-Sleep -Milliseconds 120
  }
  return ""
}

function Reset-ArtemisSession {
  param([string]$Target)
  if ($DryRun.IsPresent) { return }

  # Force-stop known Artemis/Moonlight package variants so launch starts from a clean state.
  foreach ($pkg in @("de.grill2010.artemis", "com.limelight.noir", "com.limelight")) {
    try {
      [void](Invoke-AdbOutput -Target $Target -Args @("shell", "am", "force-stop", $pkg))
    } catch {}
  }
  Start-Sleep -Milliseconds 100
}

function Get-UiNodeCenterByText {
  param(
    [string]$Target,
    [string]$Needle
  )
  if ($DryRun.IsPresent) {
    return [pscustomobject]@{
      x = 960
      y = 540
      source = "dryrun"
    }
  }
  if ([string]::IsNullOrWhiteSpace([string]$Needle)) { return $null }
  $needleNorm = ([string]$Needle).Trim().ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($needleNorm)) { return $null }

  # uiautomator dump yields clickable node bounds we can convert into a center tap.
  [void](Invoke-AdbOutput -Target $Target -Args @("shell", "uiautomator", "dump", "/sdcard/aidolon_ui.xml"))
  $xmlRaw = Invoke-AdbOutput -Target $Target -Args @("shell", "cat", "/sdcard/aidolon_ui.xml")
  if ([string]::IsNullOrWhiteSpace([string]$xmlRaw)) { return $null }

  try {
    [xml]$doc = $xmlRaw
  } catch {
    return $null
  }

  $nodes = @($doc.SelectNodes("//node[@bounds]"))
  foreach ($node in $nodes) {
    $textVal = ([string]$node.GetAttribute("text")).Trim()
    $descVal = ([string]$node.GetAttribute("content-desc")).Trim()
    $merged = "$textVal $descVal".Trim().ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($merged)) { continue }
    if (-not $merged.Contains($needleNorm)) { continue }

    $bounds = [string]$node.GetAttribute("bounds")
    $m = [regex]::Match($bounds, "^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$")
    if (-not $m.Success) { continue }

    $x1 = [int]$m.Groups[1].Value
    $y1 = [int]$m.Groups[2].Value
    $x2 = [int]$m.Groups[3].Value
    $y2 = [int]$m.Groups[4].Value
    if ($x2 -le $x1 -or $y2 -le $y1) { continue }

    return [pscustomobject]@{
      x = [int](($x1 + $x2) / 2)
      y = [int](($y1 + $y2) / 2)
      source = if ($textVal) { $textVal } else { $descVal }
    }
  }

  return $null
}

function Focus-BrowserWindow {
  param(
    [int]$TargetPid,
    [string]$ProcessName = "",
    [int]$TimeoutMs = 7000
  )
  if ($DryRun.IsPresent) {
    return [pscustomobject]@{
      focused = $true
      method = "dryrun"
      handle = ""
    }
  }
  if ($TargetPid -le 0) {
    return [pscustomobject]@{
      focused = $false
      method = "invalid_pid"
      handle = ""
    }
  }
  Add-Type -AssemblyName Microsoft.VisualBasic -ErrorAction SilentlyContinue | Out-Null
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  $resolvedHandle = ""
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      if ([Microsoft.VisualBasic.Interaction]::AppActivate($TargetPid)) {
        Start-Sleep -Milliseconds 120
        try {
          $p = Get-Process -Id $TargetPid -ErrorAction Stop
          if ($p.MainWindowHandle -ne 0) {
            $resolvedHandle = ("0x{0:X}" -f [int64]$p.MainWindowHandle)
          }
        } catch {}
        return [pscustomobject]@{
          focused = $true
          method = "pid_appactivate"
          handle = $resolvedHandle
        }
      }
    } catch {}
    Start-Sleep -Milliseconds 120
  }

  # Firefox and Chromium can hand the visible top window to a different PID.
  $needle = ([string]$ProcessName).Trim().ToLowerInvariant()
  if ($needle.EndsWith(".exe")) {
    $needle = $needle.Substring(0, $needle.Length - 4)
  }
  if ([string]::IsNullOrWhiteSpace($needle)) {
    $needle = "firefox"
  }
  $safeToken = [regex]::Escape($needle)
  $focusRegex = "(?i)\b$safeToken\b"
  try {
    $focusResp = Invoke-Ui -Arguments @{
      Action = "focus"
      Regex = $focusRegex
      AllowAmbiguousFocus = $true
    }
    $winHandle = [string]$focusResp.result.window.handle
    return [pscustomobject]@{
      focused = $true
      method = "ui_regex_focus"
      handle = $winHandle
    }
  } catch {}

  return [pscustomobject]@{
    focused = $false
    method = "failed"
    handle = ""
  }
}

function Start-BrowserSession {
  param(
    [string]$ProcessName,
    [string]$Url1,
    [string]$Url2,
    [string]$RepoRootPath,
    [bool]$UseIsolatedFirefoxProfile = $false
  )

  $procName = ([string]$ProcessName).Trim()
  if ([string]::IsNullOrWhiteSpace($procName)) {
    throw "BrowserProcess is empty."
  }

  $exeName = if ($procName.ToLowerInvariant().EndsWith(".exe")) { $procName } else { "$procName.exe" }
  $lowerProc = $procName.ToLowerInvariant()
  if ($lowerProc.EndsWith(".exe")) {
    $lowerProc = $lowerProc.Substring(0, $lowerProc.Length - 4)
  }

  if ($lowerProc -eq "firefox") {
    if (-not $UseIsolatedFirefoxProfile) {
      # Always spawn a fresh Firefox window in the current profile.
      # Capture existing handles so move/maximize can target the new window directly.
      $beforeHandles = @(Get-BrowserWindowHandles -ProcessName $lowerProc)
      $first = if (-not [string]::IsNullOrWhiteSpace([string]$Url1)) { [string]$Url1 } else { "about:blank" }
      $args = @("-new-window", $first)
      if (-not [string]::IsNullOrWhiteSpace([string]$Url2)) {
        $args += "-new-tab"
        $args += [string]$Url2
      }
      $proc = Start-Process -FilePath $exeName -ArgumentList $args -PassThru
      $newHandle = Wait-NewBrowserWindowHandle -ProcessName $lowerProc -BeforeHandles $beforeHandles -TimeoutMs 8000
      return [pscustomobject]@{
        pid = $proc.Id
        process = $lowerProc
        isolated = $false
        navigateViaUi = $false
        windowHandle = [string]$newHandle
      }
    }

    $staleClosed = Stop-WatchTvPrepFirefoxProcesses
    $profilesRoot = Join-Path $RepoRootPath "runtime\browser_profiles"
    [void](New-Item -ItemType Directory -Path $profilesRoot -Force)
    $profileName = "watch_tv_prep_main"
    $profilePath = Join-Path $profilesRoot $profileName
    [void](New-Item -ItemType Directory -Path $profilePath -Force)

    # Seed profile prefs once to suppress first-run and default-browser prompts.
    $userJsPath = Join-Path $profilePath "user.js"
    if (-not (Test-Path -LiteralPath $userJsPath)) {
      @(
        'user_pref("browser.aboutwelcome.enabled", false);',
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("browser.startup.homepage_override.mstone", "ignore");',
        'user_pref("startup.homepage_welcome_url", "about:blank");',
        'user_pref("startup.homepage_welcome_url.additional", "");'
      ) | Set-Content -LiteralPath $userJsPath -Encoding ASCII
    }

    $extensionsDir = Join-Path $profilePath "extensions"
    [void](New-Item -ItemType Directory -Path $extensionsDir -Force)
    $uBlockId = "uBlock0@raymondhill.net"
    $uBlockPath = Join-Path $extensionsDir "$uBlockId.xpi"
    $uBlockSeeded = $false
    $uBlockError = ""
    if (-not (Test-Path -LiteralPath $uBlockPath)) {
      try {
        $uBlockUrl = "https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi"
        Invoke-WebRequest -Uri $uBlockUrl -OutFile $uBlockPath -MaximumRedirection 8 -ErrorAction Stop | Out-Null
        $fileInfo = Get-Item -LiteralPath $uBlockPath -ErrorAction Stop
        if ($fileInfo.Length -le 0) {
          throw "Downloaded extension file is empty."
        }
        $uBlockSeeded = $true
      } catch {
        $uBlockError = [string]$_.Exception.Message
        Remove-Item -LiteralPath $uBlockPath -ErrorAction SilentlyContinue
      }
    }

    $args = @("-no-remote", "-profile", $profilePath)
    if (-not [string]::IsNullOrWhiteSpace([string]$Url1)) {
      $args += "-new-window"
      $args += [string]$Url1
    } else {
      $args += "-new-window"
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$Url2)) {
      $args += "-new-tab"
      $args += [string]$Url2
    }

    $beforeHandles = @(Get-BrowserWindowHandles -ProcessName $lowerProc)
    $proc = Start-Process -FilePath $exeName -ArgumentList $args -PassThru
    $newHandle = Wait-NewBrowserWindowHandle -ProcessName $lowerProc -BeforeHandles $beforeHandles -TimeoutMs 8000
    return [pscustomobject]@{
      pid = $proc.Id
      process = $lowerProc
      isolated = $true
      navigateViaUi = $false
      windowHandle = [string]$newHandle
      staleWatchSessionsClosed = $staleClosed
      adblockInstalled = (Test-Path -LiteralPath $uBlockPath)
      adblockSeededNow = $uBlockSeeded
      adblockError = $uBlockError
    }
  }

  $genericArgs = @()
  if (-not [string]::IsNullOrWhiteSpace([string]$Url1)) { $genericArgs += [string]$Url1 }
  if (-not [string]::IsNullOrWhiteSpace([string]$Url2)) { $genericArgs += [string]$Url2 }
  $genericProc = Start-Process -FilePath $exeName -ArgumentList $genericArgs -PassThru
  return [pscustomobject]@{
    pid = $genericProc.Id
    process = $lowerProc
    isolated = $false
    navigateViaUi = $false
    windowHandle = ""
  }
}

function Open-UrlsInFocusedBrowserWindow {
  param(
    [string]$Url1,
    [string]$Url2
  )

  $urls = @()
  foreach ($candidate in @($Url1, $Url2)) {
    $clean = [string]$candidate
    if ([string]::IsNullOrWhiteSpace($clean)) { continue }
    $urls += $clean.Trim()
  }
  if ($urls.Count -eq 0) { return }

  for ($idx = 0; $idx -lt $urls.Count; $idx++) {
    $url = [string]$urls[$idx]
    if ($idx -gt 0) {
      [void](Invoke-Ui -Arguments @{
          Action = "key"
          Keys = "Ctrl+T"
        })
      Start-Sleep -Milliseconds 70
    }
    [void](Invoke-Ui -Arguments @{
        Action = "key"
        Keys = "Ctrl+L"
      })
    Start-Sleep -Milliseconds 50
    [void](Invoke-Ui -Arguments @{
        Action = "type"
        Text = $url
        TypeDirect = $true
      })
    [void](Invoke-Ui -Arguments @{
        Action = "key"
        Keys = "Enter"
      })
    Start-Sleep -Milliseconds 130
  }
}

function Get-WatchTvPrepFirefoxProcessIds {
  param([string]$RepoRootPath)
  $ids = @()
  if ($DryRun.IsPresent) { return $ids }
  try {
    $needle = (Join-Path $RepoRootPath "runtime\browser_profiles\watch_tv_prep_").ToLowerInvariant()
    $items = @(Get-CimInstance Win32_Process -Filter "Name = 'firefox.exe'" -ErrorAction Stop)
    foreach ($item in $items) {
      $cmd = [string]$item.CommandLine
      if ([string]::IsNullOrWhiteSpace($cmd)) { continue }
      if ($cmd.ToLowerInvariant().Contains($needle)) {
        $ids += [int]$item.ProcessId
      }
    }
  } catch {
    return @()
  }
  return @($ids | Sort-Object -Unique)
}

function Stop-WatchTvPrepFirefoxProcesses {
  $closed = 0
  if ($DryRun.IsPresent) { return $closed }
  $pids = @(Get-WatchTvPrepFirefoxProcessIds -RepoRootPath $repoRoot)
  if ($pids.Count -eq 0) {
    return $closed
  }
  foreach ($pid in $pids) {
    try {
      Stop-Process -Id $pid -Force -ErrorAction Stop
      $closed++
    } catch {}
  }
  if ($closed -gt 0) {
    Start-Sleep -Milliseconds 90
  }
  return $closed
}

if ($MoveDirection -ne "Left" -and $MoveDirection -ne "Right") {
  throw "MoveDirection must be Left or Right."
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
$TvPowerScript = Join-Path $scriptRoot "tv_power.ps1"
$TvOpenScript = Join-Path $scriptRoot "tv_open_app.ps1"
$TvCloseScript = Join-Path $scriptRoot "tv_close_app.ps1"
$script:UiScript = Join-Path $scriptRoot "ui_automation.ps1"

foreach ($must in @($TvPowerScript, $TvOpenScript, $TvCloseScript, $script:UiScript)) {
  if (-not (Test-Path -LiteralPath $must)) {
    throw "Required tool script is missing."
  }
}

$summary = [ordered]@{
  ok = $false
  mode = if ($DryRun.IsPresent) { "dry-run" } else { "live" }
  steps = @()
  streamVerified = $false
  firstUrl = $FirstUrl
  secondUrl = $SecondUrl
}

$previousUiAllow = [string]$env:AIDOLON_UI_ALLOW_MUTATIONS
$env:AIDOLON_UI_ALLOW_MUTATIONS = "1"

try {
  $target = Resolve-AdbTarget
  $initialScreenCount = Get-ScreenCountSafe
  $reuseExistingConnection = $false
  $reusePackage = ""
  if (-not $DryRun.IsPresent -and $PreferReuseExistingConnection) {
    try {
      $reusePackage = Get-ForegroundPackage -Target $target
      if ($initialScreenCount -gt 1 -and (Test-ArtemisPackage -PackageName $reusePackage)) {
        $reuseExistingConnection = $true
      }
    } catch {}
  }
  if ($reuseExistingConnection) {
    $summary.steps += "reuse_existing_connection"
    $summary.connectionMode = "reused"
    $summary.artemisForegroundPackage = $reusePackage
    $summary.streamVerified = $true
  } else {
    $summary.steps += "restart_sunshine"
    $stoppedSunshineCount = 0
    $sunshineAlreadyRunning = $false
    if (-not $DryRun.IsPresent) {
      $sunshineAlreadyRunning = Test-SunshineRunning
    }
    if ($sunshineAlreadyRunning) {
      $stoppedSunshineCount = Stop-SunshineProcesses
    }
    Invoke-SunshineStart -CommandText $SunshineCommand
    Start-Sleep -Milliseconds $SunshineWaitMs
    if ($DryRun.IsPresent) {
      $summary.sunshineAction = "dry_run"
    } else {
      $summary.sunshineAction = if ($sunshineAlreadyRunning) { "restarted" } else { "started" }
      if ($sunshineAlreadyRunning) {
        $summary.sunshineStoppedCount = $stoppedSunshineCount
      }
    }
    if (-not $DryRun.IsPresent -and -not (Test-SunshineRunning)) {
      throw "Sunshine did not start. Stopping before TV connection."
    }

    $summary.steps += "tv_power_on"
    $tvPower = Invoke-JsonScript -ScriptPath $TvPowerScript -Arguments @{
      Action = "on"
      WaitMs = $TvPowerWaitMs
      Host = $TvHost
      Port = $TvPort
      Serial = $TvSerial
    }
    if (-not $tvPower.ok) {
      throw "TV power on failed: $([string]$tvPower.error)"
    }

    $summary.steps += "open_artemis"
    $maxArtemisForegroundAttempts = 3
    $lastForegroundPackage = ""
    $artemisForegroundVerified = $false
    for ($attempt = 1; $attempt -le $maxArtemisForegroundAttempts; $attempt++) {
      # Normalize state first in case Artemis was already open on a non-stream screen.
      Reset-ArtemisSession -Target $target
      Send-AdbKey -Target $target -Code 3 # Home
      Start-Sleep -Milliseconds 120

      $tvApp = Invoke-JsonScript -ScriptPath $TvOpenScript -Arguments @{
        Action = "artemis"
        WaitMs = $ArtemisWaitMs
        Host = $TvHost
        Port = $TvPort
        Serial = $TvSerial
      }
      if (-not $tvApp.ok) {
        throw "Opening Artemis failed: $([string]$tvApp.error)"
      }
      Start-Sleep -Milliseconds 110
      $lastForegroundPackage = Get-ForegroundPackage -Target $target
      if (Test-ArtemisPackage -PackageName $lastForegroundPackage) {
        $artemisForegroundVerified = $true
        break
      }

      # Recover from popups/other foreground apps (USB chooser, previous app, etc.).
      Send-AdbKey -Target $target -Code 4   # Back
      Start-Sleep -Milliseconds 90
      Send-AdbKey -Target $target -Code 3   # Home
      Start-Sleep -Milliseconds 180
      if ($lastForegroundPackage -like "com.retroarch*") {
        $null = Invoke-JsonScript -ScriptPath $TvCloseScript -Arguments @{
          Action = "retroarch"
          Host = $TvHost
          Port = $TvPort
          Serial = $TvSerial
          WaitMs = 400
        }
      }
    }
    $summary.artemisForegroundPackage = $lastForegroundPackage
    if (-not $artemisForegroundVerified) {
      throw "Artemis was not in foreground after launch attempts. Stopping before connection keys."
    }

    $baselineScreens = Get-ScreenCountSafe
  }

  $summary.steps += "set_audio_output"
  $audioSet = Set-PreferredPlaybackDevice -DeviceName $PreferredAudioDevice
  $summary.audioDeviceTarget = [string]$PreferredAudioDevice
  $summary.audioDeviceSwitchAttempted = [bool]$audioSet.attempted
  $summary.audioDeviceSwitchApplied = [bool]$audioSet.changed
  if (-not [string]::IsNullOrWhiteSpace([string]$audioSet.matched)) {
    $summary.audioDeviceMatched = [string]$audioSet.matched
  }
  if (-not [string]::IsNullOrWhiteSpace([string]$audioSet.warning)) {
    $summary.audioDeviceWarning = [string]$audioSet.warning
  }
  $audioAvailable = @()
  if ($audioSet.PSObject.Properties.Name -contains "available") {
    $audioAvailable = @($audioSet.available)
  }
  if ($audioAvailable.Count -gt 0) {
    $summary.audioDeviceAvailable = @($audioAvailable)
  }

  if (-not $reuseExistingConnection) {
    $summary.steps += "artemis_connect_attempt"
    if ($ArtemisLoadWaitMs -gt 0) {
      Start-Sleep -Milliseconds $ArtemisLoadWaitMs
    }
    if (-not $SkipArtemisKeySequence.IsPresent) {
      # Ensure we are not stuck in Artemis settings and start from grid context.
      $fgComponent = Get-ForegroundComponent -Target $target
      if (([string]$fgComponent.activity).ToLowerInvariant().Contains("settings")) {
        Send-AdbKey -Target $target -Code 4
        Start-Sleep -Milliseconds 140
      }

      # Deterministic connect flow requested by user:
      # 1) On Artemis main screen, move right once, then Enter.
      # 2) On next panel, move right twice, then Enter.
      $summary.artemisSelectionMethod = "dpad_right1_enter_right2_enter"
      for ($i = 0; $i -lt 1; $i++) {
        Send-AdbKey -Target $target -Code 22
        Start-Sleep -Milliseconds 60
      }
      Send-AdbKey -Target $target -Code 23
      Start-Sleep -Milliseconds 380
      for ($i = 0; $i -lt 2; $i++) {
        Send-AdbKey -Target $target -Code 22
        Start-Sleep -Milliseconds 60
      }
      Send-AdbKey -Target $target -Code 23
    }

    $deadline = [DateTime]::UtcNow.AddMilliseconds($StreamDetectTimeoutMs)
    if ($DryRun.IsPresent) {
      $summary.streamVerified = $true
    }
    while ([DateTime]::UtcNow -lt $deadline) {
      if ($DryRun.IsPresent) { break }
      $currentScreens = Get-ScreenCountSafe
      if ($baselineScreens -gt 0 -and $currentScreens -gt $baselineScreens) {
        $summary.streamVerified = $true
        break
      }
      Start-Sleep -Milliseconds $StreamDetectPollMs
    }
    if (-not $summary.streamVerified -and -not $AllowUnverifiedStream.IsPresent) {
      throw "Artemis connection was not verified. Stopping before browser automation."
    }
  }

  if ($DryRun.IsPresent) {
    $summary.steps += "open_firefox_window"
    $summary.steps += "move_and_maximize"
    $summary.steps += "open_sites"
    $summary.ok = $true
    $summary.message = "Dry run complete. No actions were executed."
    ($summary | ConvertTo-Json -Compress -Depth 8)
    exit 0
  }

  $summary.steps += "open_firefox_window"
  $browser = Start-BrowserSession -ProcessName $BrowserProcess -Url1 $FirstUrl -Url2 $SecondUrl -RepoRootPath $repoRoot -UseIsolatedFirefoxProfile $UseIsolatedFirefoxProfile.IsPresent
  Start-Sleep -Milliseconds $BrowserSettleMs
  $resolvedHandle = [string]$browser.windowHandle
  $focusMethod = "launch_window_handle"
  if ([string]::IsNullOrWhiteSpace([string]$resolvedHandle)) {
    $focusResult = Focus-BrowserWindow -TargetPid ([int]$browser.pid) -ProcessName ([string]$browser.process) -TimeoutMs 9000
    if (-not [bool]$focusResult.focused) {
      throw "Could not focus the browser window."
    }
    $resolvedHandle = [string]$focusResult.handle
    $focusMethod = [string]$focusResult.method
  }
  if ([string]::IsNullOrWhiteSpace([string]$resolvedHandle)) {
    throw "Could not resolve browser window handle."
  }
  $summary.browserIsolated = [bool]$browser.isolated
  $summary.browserFocusMethod = $focusMethod
  if ($browser.PSObject.Properties.Name -contains "adblockInstalled") {
    $summary.browserAdblockInstalled = [bool]$browser.adblockInstalled
  }
  if ($browser.PSObject.Properties.Name -contains "adblockSeededNow") {
    $summary.browserAdblockSeededNow = [bool]$browser.adblockSeededNow
  }
  if (($browser.PSObject.Properties.Name -contains "adblockError") -and -not [string]::IsNullOrWhiteSpace([string]$browser.adblockError)) {
    $summary.browserAdblockWarning = [string]$browser.adblockError
  }

  $summary.steps += "move_and_maximize"
  $screenCountNow = Get-ScreenCountSafe
  $moveResult = Move-WindowToAdjacentScreenSafe -HandleHex $resolvedHandle -Direction $MoveDirection
  if ($moveResult.before -ge 0) {
    $summary.browserScreenBeforeMove = [int]$moveResult.before
  }
  if ($moveResult.after -ge 0) {
    $summary.browserScreenAfterMove = [int]$moveResult.after
  }
  if ($screenCountNow -gt 1 -and -not [bool]$moveResult.moved) {
    throw "Browser window did not move to another monitor."
  }
  Start-Sleep -Milliseconds 110
  $summary.browserMaximizedApplied = [bool](Maximize-WindowSafe -HandleHex $resolvedHandle)
  if (-not $summary.browserMaximizedApplied) {
    $summary.browserMaximizeWarning = "Window maximize call failed; leaving normal window size."
  }

  $summary.steps += "open_sites"
  Start-Sleep -Milliseconds 80
  if ([bool]$browser.navigateViaUi) {
    Open-UrlsInFocusedBrowserWindow -Url1 $FirstUrl -Url2 $SecondUrl
  }

  $summary.ok = $true
  $summary.message = "TV prep is complete. Ready for show/movie selection."
  ($summary | ConvertTo-Json -Compress -Depth 8)
  exit 0
} catch {
  $summary.ok = $false
  $summary.error = [string]$_.Exception.Message
  ($summary | ConvertTo-Json -Compress -Depth 8)
  exit 1
} finally {
  if ([string]::IsNullOrEmpty($previousUiAllow)) {
    Remove-Item Env:AIDOLON_UI_ALLOW_MUTATIONS -ErrorAction SilentlyContinue
  } else {
    $env:AIDOLON_UI_ALLOW_MUTATIONS = $previousUiAllow
  }
}
