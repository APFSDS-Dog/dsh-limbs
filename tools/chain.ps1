# Dev helper: run a chain of UIA clicks inside the DSH window, all in ONE process
# so focus never leaves the app between steps (the picker menu closes on blur).
#
#   pwsh -File tools\chain.ps1 -Steps '^DeepSeek V4\.1 Flash;;^配置$' -Dump dialog
#
# Steps are ';;'-separated regexes matched against visible UIA element names; the
# first match of each is clicked with a real mouse event at its centre. A single
# string is used because `pwsh -File` splits quoted comma lists on spaces.
param(
  [string]$Steps = '',
  [int]$WaitMs = 900,
  [ValidateSet('none', 'all', 'dialog')]
  [string]$Dump = 'dialog',
  [string]$Shot = ''
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ChainWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder t, int c);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref System.Drawing.Point p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public static IntPtr Find(string t) {
    IntPtr f = IntPtr.Zero;
    EnumWindows((h,l) => { if(!IsWindowVisible(h)) return true; var sb=new StringBuilder(512); GetWindowTextW(h,sb,512); if(sb.ToString().Contains(t)){f=h;return false;} return true; }, IntPtr.Zero);
    return f;
  }
  /** True only when `target`'s process owns the foreground window. */
  public static bool IsForegroundOf(IntPtr target) {
    IntPtr fg = GetForegroundWindow();
    if (fg == IntPtr.Zero) return false;
    uint a, b;
    GetWindowThreadProcessId(fg, out a);
    GetWindowThreadProcessId(target, out b);
    return a == b && a != 0;
  }
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(50);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
"@

$hwnd = [ChainWin]::Find('DeepSeek Harness')
if ($hwnd -eq [IntPtr]::Zero) { Write-Error 'DSH window not found'; exit 1 }
[void][ChainWin]::ShowWindow($hwnd, 9)
[void][ChainWin]::BringWindowToTop($hwnd)
[void][ChainWin]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040)  # NOSIZE|NOMOVE|SHOWWINDOW
[void][ChainWin]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 500

# Hard stop: a real mouse click goes to whatever window is on top, so never
# proceed unless DSH actually owns the foreground. This is what kept a mis-click
# from landing in Photoshop.
if (-not [ChainWin]::IsForegroundOf($hwnd)) {
  Write-Error 'DSH is NOT the foreground window — refusing to click (a click would land in another app). Bring DSH to the front and retry.'
  exit 2
}

$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)

function Get-Visible {
  param($Filter = '')
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $out = New-Object System.Collections.Generic.List[object]
  for ($i = 0; $i -lt $all.Count; $i++) {
    $e = $all.Item($i)
    $c = $e.Current
    if ($c.IsOffscreen) { continue }
    if ($Filter -ne '' -and $c.Name -notmatch $Filter) { continue }
    $out.Add([pscustomobject]@{
      Name = $c.Name
      Type = ($c.ControlType.ProgrammaticName -replace 'ControlType\.', '')
      Class = $c.ClassName
      Rect = $c.BoundingRectangle
      Element = $e
    })
  }
  return $out
}

foreach ($step in ($Steps -split ';;' | Where-Object { $_ -ne '' })) {
  $hits = Get-Visible -Filter $step
  if ($hits.Count -eq 0) {
    Write-Output "STEP '$step': no visible match"
    break
  }
  # Prefer buttons/tabs/tree items over decorative text for the same label.
  $pref = $hits | Where-Object { $_.Type -in @('Button', 'Tab', 'TreeItem', 'ListItem', 'MenuItem') }
  $target = if ($pref.Count -gt 0) { $pref[0] } else { $hits[0] }
  $r = $target.Rect
  if ($r.IsEmpty) { Write-Output "STEP '$step': matched but has no rect"; break }
  $x = [int]($r.X + $r.Width / 2)
  $y = [int]($r.Y + $r.Height / 2)
  Write-Output ("STEP '{0}' -> {1} '{2}' at {3},{4}" -f $step, $target.Type, $target.Name, $x, $y)
  [ChainWin]::Click($x, $y)
  Start-Sleep -Milliseconds $WaitMs
}

switch ($Dump) {
  'none' {}
  'all' {
    foreach ($it in (Get-Visible)) {
      $r = $it.Rect
      $rect = if ($r.IsEmpty) { '-' } else { '{0},{1} {2}x{3}' -f [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height }
      $n = ($it.Name -replace "`r?`n", ' / ')
      if ($n.Length -gt 80) { $n = $n.Substring(0, 80) + '…' }
      '{0,-12} {1,-20} {2}' -f $it.Type, $rect, $n
    }
  }
  'dialog' {
    $rows = Get-Visible -Filter '设置|模型|提供|账号|通用|快捷键|关于|外观|对话|记忆|语音'
    foreach ($it in $rows) {
      $r = $it.Rect
      $rect = if ($r.IsEmpty) { '-' } else { '{0},{1} {2}x{3}' -f [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height }
      '{0,-12} {1,-20} {2}' -f $it.Type, $rect, $it.Name
    }
  }
}

if ($Shot -ne '') {
  $cli = New-Object ChainWin+RECT
  [void][ChainWin]::GetClientRect($hwnd, [ref]$cli)
  $o = New-Object System.Drawing.Point(0, 0)
  [void][ChainWin]::ClientToScreen($hwnd, [ref]$o)
  $bmp = New-Object System.Drawing.Bitmap($cli.Right, $cli.Bottom)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($o.X, $o.Y, 0, 0, $bmp.Size)
  $g.Dispose()
  $dir = Split-Path -Parent $Shot
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "shot: $Shot ($($cli.Right)x$($cli.Bottom))"
}
