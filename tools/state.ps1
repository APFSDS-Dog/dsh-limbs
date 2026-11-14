# Dev helper: one consistent pass — dump the DSH window geometry, UIA hit list,
# and a screenshot, so clicks and screenshots share one state.
param(
  [string]$Filter = '',
  [string]$Shot = 'D:\Projects\dsh-limbs\shots\state.png'
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DshState {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder t, int c);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref System.Drawing.Point p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  public static IntPtr Find(string t) {
    IntPtr f = IntPtr.Zero;
    EnumWindows((h,l) => { if(!IsWindowVisible(h)) return true; var sb=new StringBuilder(512); GetWindowTextW(h,sb,512); if(sb.ToString().Contains(t)){f=h;return false;} return true; }, IntPtr.Zero);
    return f;
  }
}
"@

$hwnd = [DshState]::Find('DeepSeek Harness')
if ($hwnd -eq [IntPtr]::Zero) { Write-Error 'window not found'; exit 1 }
[void][DshState]::ShowWindow($hwnd, 9)
[void][DshState]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 350

$win = New-Object DshState+RECT
[void][DshState]::GetWindowRect($hwnd, [ref]$win)
$cli = New-Object DshState+RECT
[void][DshState]::GetClientRect($hwnd, [ref]$cli)
$origin = New-Object System.Drawing.Point(0, 0)
[void][DshState]::ClientToScreen($hwnd, [ref]$origin)

Write-Output ("window  : {0},{1} {2}x{3}" -f $win.Left, $win.Top, ($win.Right - $win.Left), ($win.Bottom - $win.Top))
Write-Output ("client  : {0},{1} {2}x{3}" -f $origin.X, $origin.Y, $cli.Right, $cli.Bottom)

$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$rows = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $all.Count; $i++) {
  $e = $all.Item($i)
  $c = $e.Current
  if ($c.IsOffscreen) { continue }
  if ($Filter -ne '' -and $c.Name -notmatch $Filter) { continue }
  $t = ($c.ControlType.ProgrammaticName -replace 'ControlType\.', '')
  $r = $c.BoundingRectangle
  $rect = if ($r.IsEmpty) { '-' } else { '{0},{1} {2}x{3}' -f [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height }
  $name = ($c.Name -replace "`r?`n", ' / ')
  if ($name.Length -gt 90) { $name = $name.Substring(0, 90) + '…' }
  $rows.Add(('{0,-12} {1,-22} {2}' -f $t, $rect, $name))
}
Write-Output ("uia     : total={0} shown={1}" -f $all.Count, $rows.Count)
$rows

$bmp = New-Object System.Drawing.Bitmap($cli.Right, $cli.Bottom)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($origin.X, $origin.Y, 0, 0, $bmp.Size)
$g.Dispose()
$dir = Split-Path -Parent $Shot
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "shot    : $Shot"
