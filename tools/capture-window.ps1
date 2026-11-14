# Capture the DeepSeek Harness main window to a PNG (dev tool, not shipped).
# PrintWindow on this WebView2 window only returns the visible strip, so the
# window rectangle is copied from the screen instead (window must be foreground
# and unobscured).
param(
  [string]$Out = 'D:\Projects\dsh-limbs\shots\harness.png',
  [string]$TitleLike = 'DeepSeek Harness',
  [switch]$PrintWindow
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinCap {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder t, int c);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT value, int size);
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      if (sb.ToString().Contains(title)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$hwnd = [WinCap]::Find($TitleLike)
if ($hwnd -eq [IntPtr]::Zero) { Write-Error "no window containing '$TitleLike' found"; exit 1 }

[void][WinCap]::ShowWindow($hwnd, 9)      # SW_RESTORE
[void][WinCap]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 500

$rect = New-Object WinCap+RECT
$extended = New-Object WinCap+RECT
$ok = [WinCap]::DwmGetWindowAttribute($hwnd, 9, [ref]$extended, 16) -eq 0
if ($ok) { $rect = $extended } else { [void][WinCap]::GetWindowRect($hwnd, [ref]$rect) }

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) { Write-Error "window has no size"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap($width, $height)
$g = [System.Drawing.Graphics]::FromImage($bmp)

if ($PrintWindow) {
  $hdc = $g.GetHdc()
  $printed = [WinCap]::PrintWindow($hwnd, $hdc, 2)   # PW_RENDERFULLCONTENT
  $g.ReleaseHdc($hdc)
  if (-not $printed) { $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size) }
} else {
  $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
}
$g.Dispose()

$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved: $Out ($width x $height) origin=$($rect.Left),$($rect.Top)"
