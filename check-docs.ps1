# check-docs.ps1 —— 文档自检的 Windows 启动器（check_docs.py 的壳）
#
# 为什么需要它：
#   `python` 常常不在 PATH 上。本机 PATH 里的 python 是 Microsoft Store 的
#   **0 字节占位别名**，直接跑 `python check_docs.py` 会得到 exit 9009；
#   而 DSH（DeepSeek Harness）自带的 Python 在 <DSH_HOME>\dsh-runtimes\ 下，
#   路径带版本号、会随升级变化 —— 所以这里用通配找，**不写死**。
#
# 用法：
#   pwsh -File .\check-docs.ps1
#   powershell -ExecutionPolicy Bypass -File .\check-docs.ps1
#   指定解释器：  pwsh -File .\check-docs.ps1 -Python "D:\...\python.exe"
#
# 退出码与 check_docs.py 一致：0 = 全绿，1 = 有未通过项，2 = 找不到 Python。

[CmdletBinding()]
param(
    [string]$Python = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $here 'check_docs.py'

if (-not (Test-Path -LiteralPath $target)) {
    Write-Host "找不到 check_docs.py（应与本脚本同目录）：$target" -ForegroundColor Red
    exit 2
}

# 只认真解释器：Store 的占位别名是 0 字节
function Test-RealExe([string]$path) {
    if ([string]::IsNullOrWhiteSpace($path)) { return $false }
    try { $item = Get-Item -LiteralPath $path -ErrorAction Stop } catch { return $false }
    return ($item.Length -gt 0)
}

$candidates = New-Object System.Collections.Generic.List[string]
if ($Python) { $candidates.Add($Python) }

# ① PATH 上的 python / python3
foreach ($name in @('python', 'python3')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { $candidates.Add($cmd.Source) }
}

# ② py 启动器（能问到真实解释器路径就更好）
$pyLauncher = Get-Command 'py' -ErrorAction SilentlyContinue
if ($pyLauncher -and (Test-RealExe $pyLauncher.Source)) {
    try {
        $real = & $pyLauncher.Source -c "import sys;print(sys.executable)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $real) { $candidates.Add($real.Trim()) }
    } catch { }
}

# ③ DSH 自带运行时（目录名带版本，用通配，别写死）
if ($env:DSH_HOME) {
    $runtimes = Join-Path $env:DSH_HOME 'dsh-runtimes'
    Get-ChildItem -LiteralPath $runtimes -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $candidates.Add((Join-Path $_.FullName 'dependencies\python\python.exe'))
    }
}

# ④ 常见安装位置
foreach ($p in @(
        "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
        'C:\Python313\python.exe',
        'C:\Python312\python.exe',
        'C:\Python311\python.exe'
    )) { $candidates.Add($p) }

$chosen = $candidates | Where-Object { Test-RealExe $_ } | Select-Object -First 1
if (-not $chosen) {
    Write-Host '找不到可用的 Python。' -ForegroundColor Red
    Write-Host 'PATH 上的 python 可能是 Microsoft Store 的 0 字节占位别名（跑起来是 exit 9009）。'
    Write-Host '两个办法，选一个：'
    Write-Host '  1) 装 Python 3 并勾选 "Add python.exe to PATH"：https://www.python.org/downloads/'
    Write-Host '  2) 用 DSH 自带 Python：pwsh -File .\check-docs.ps1 -Python "<DSH_HOME>\dsh-runtimes\<版本>\dependencies\python\python.exe"'
    exit 2
}

Write-Host "Python: $chosen"
& $chosen $target @args
exit $LASTEXITCODE
