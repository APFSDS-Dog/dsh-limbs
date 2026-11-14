# Dev tool: find/invoke UI Automation elements inside the DeepSeek Harness window.
# Usage:
#   pwsh -File tools/uia.ps1 -Action dump  [-Filter '设置|配置|模型'] [-MaxDepth 24] [-MaxNodes 4000]
#   pwsh -File tools/uia.ps1 -Action click -Name '配置'
#   pwsh -File tools/uia.ps1 -Action dlg        # list the settings dialog subtree only
param(
  [ValidateSet('dump', 'click', 'dlg', 'invoke')]
  [string]$Action = 'dump',
  [string]$Filter = '',
  [string]$Name = '',
  [int]$MaxDepth = 24,
  [int]$MaxNodes = 6000,
  [switch]$VisibleOnly
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DshWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
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

$hwnd = [DshWin]::Find('DeepSeek Harness')
if ($hwnd -eq [IntPtr]::Zero) { Write-Error 'DSH window not found'; exit 1 }
[void][DshWin]::ShowWindow($hwnd, 9)
[void][DshWin]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 200

$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
if (-not $root) { Write-Error 'UIA root unavailable'; exit 1 }

# Cache descendants once; it is far faster than walking per query.
$cache = [System.Windows.Automation.CacheRequest]::new()
$cache.TreeScope = [System.Windows.Automation.TreeScope]::Element -bor [System.Windows.Automation.TreeScope]::Descendants
$cache.TreeFilter = [System.Windows.Automation.Automation]::RawViewCondition
$cache.Add([System.Windows.Automation.AutomationElement]::NameProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::ClassNameProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::AutomationIdProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::IsEnabledProperty)
$cache.Push()
try {
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
} finally { $cache.Pop() }

$items = New-Object System.Collections.Generic.List[object]
for ($i = 0; $i -lt $all.Count -and $i -lt $MaxNodes; $i++) {
  $e = $all.Item($i)
  $items.Add([pscustomobject]@{
    Element = $e
    Name = $e.Current.Name
    Type = ($e.Current.ControlType.ProgrammaticName -replace 'ControlType\.', '')
    Class = $e.Current.ClassName
    Id = $e.Current.AutomationId
    Offscreen = $e.Current.IsOffscreen
    Enabled = $e.Current.IsEnabled
    Rect = $e.Current.BoundingRectangle
  })
}

function Show-Items($rows) {
  foreach ($r in $rows) {
    $rc = $r.Rect
    $rect = if ($rc.IsEmpty) { '-' } else { '{0},{1} {2}x{3}' -f [int]$rc.X, [int]$rc.Y, [int]$rc.Width, [int]$rc.Height }
    $text = ($r.Name -replace "`r?`n", ' / ')
    if ($text.Length -gt 200) { $text = $text.Substring(0, 200) + '…' }
    '{0,-13} off={1,-5} en={2,-5} {3,-22} {4}' -f $r.Type, $r.Offscreen, $r.Enabled, $rect, $text
  }
}

switch ($Action) {
  'dump' {
    $rows = $items
    if ($Filter -ne '') { $rows = $rows | Where-Object { $_.Name -match $Filter } }
    if ($VisibleOnly) { $rows = $rows | Where-Object { -not $_.Offscreen } }
    Write-Output ('descendants={0} shown={1}' -f $items.Count, $rows.Count)
    Show-Items $rows
  }
  'dlg' {
    # Everything inside the settings dialog, for verifying which section is active.
    $dmonly = $items | Where-Object { $_.Class -match 'panel|navCell|navLabel|navTitle|overlay|mask' }
    Write-Output ('dialog nodes={0}' -f $dmonly.Count)
    Show-Items $dmonly
  }
  'click' {
    if ($Name -eq '') { Write-Error '-Name is required'; exit 1 }
    $hits = $items | Where-Object { $_.Name -eq $Name -and -not $_.Offscreen }
    if ($hits.Count -eq 0) { $hits = $items | Where-Object { $_.Name -match $Name -and -not $_.Offscreen } }
    if ($hits.Count -eq 0) { Write-Error "no element matched '$Name'"; exit 1 }
    $target = $hits[0]
    $rc = $target.Rect
    $x = [int]($rc.X + $rc.Width / 2)
    $y = [int]($rc.Y + $rc.Height / 2)
    Write-Output ("clicking {0} '{1}' at {2},{3}" -f $target.Type, $target.Name, $x, $y)
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(40);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
"@
    [DshMouse]::Click($x, $y)
    Write-Output 'clicked'
  }
  'invoke' {
    if ($Name -eq '') { Write-Error '-Name is required'; exit 1 }
    $hits = $items | Where-Object { $_.Name -match $Name -and -not $_.Offscreen }
    if ($hits.Count -eq 0) { Write-Error "no element matched '$Name'"; exit 1 }
    $target = $hits[0]
    $pattern = $null
    if ($target.Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
      $pattern.Invoke()
      Write-Output "invoked '$($target.Name)'"
    } else {
      Write-Output "no InvokePattern on '$($target.Name)' ($($target.Type))"
    }
  }
}
