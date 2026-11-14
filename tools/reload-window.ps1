# Send Ctrl+R to the DeepSeek Harness window to reload its renderer (dev tool).
# The main process reports MainWindowHandle = 0 on this machine, so the handle is
# resolved by enumerating visible top-level windows and matching the title.
param([int]$WaitMs = 6000, [string]$Title = 'DeepSeek Harness')

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinKey {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
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

$hwnd = [WinKey]::Find($Title)
if ($hwnd -eq [IntPtr]::Zero) { Write-Error "no window titled '$Title' found"; exit 1 }

[void][WinKey]::ShowWindow($hwnd, 9)      # SW_RESTORE
[void][WinKey]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 400

$VK_CONTROL = 0x11
$VK_R = 0x52
$KEYUP = 0x0002

[WinKey]::keybd_event($VK_CONTROL, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[WinKey]::keybd_event($VK_R, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[WinKey]::keybd_event($VK_R, 0, $KEYUP, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[WinKey]::keybd_event($VK_CONTROL, 0, $KEYUP, [UIntPtr]::Zero)

Start-Sleep -Milliseconds $WaitMs
Write-Output "sent Ctrl+R to hwnd $hwnd, waited ${WaitMs}ms"
