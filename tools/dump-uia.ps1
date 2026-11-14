# Dump the DeepSeek Harness window's UI Automation text tree (dev tool, not shipped).
param(
  [int]$MaxDepth = 18,
  [int]$MaxNodes = 4000,
  [string]$Out = "D:\Projects\dsh-limbs\shots\uia.txt"
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like "*DeepSeek*" } | Select-Object -First 1
if (-not $proc) { Write-Error "no DeepSeek Harness window found"; exit 1 }

$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
if (-not $root) { Write-Error "UIA root not available"; exit 1 }

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$lines = New-Object System.Collections.Generic.List[string]
$count = 0

function Walk($element, [int]$depth) {
  if ($script:count -ge $MaxNodes) { return }
  $script:count++
  $name = ""
  $cls = ""
  try { $name = $element.Current.Name } catch { }
  try { $cls = $element.Current.ClassName } catch { }
  $type = ""
  try { $type = $element.Current.ControlType.ProgrammaticName -replace 'ControlType\.', '' } catch { }
  $text = ($name -replace "`r?`n", " / ")
  if ($text.Length -gt 300) { $text = $text.Substring(0, 300) + "…" }
  $pad = "  " * [Math]::Min($depth, 30)
  $script:lines.Add(("{0}{1} [{2}] {3}" -f $pad, $type, $cls, $text))
  if ($depth -ge $MaxDepth) { return }
  $child = $walker.GetFirstChild($element)
  while ($null -ne $child) {
    Walk $child ($depth + 1)
    if ($script:count -ge $MaxNodes) { return }
    $child = $walker.GetNextSibling($child)
  }
}

$count = 0
Walk $root 0
$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$lines -join "`n" | Set-Content -Path $Out -Encoding utf8
Write-Output "saved: $Out ($($lines.Count) nodes)"
