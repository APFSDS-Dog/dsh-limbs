# 真机诊断 · dsh-limbs 的 Host 三桥到底挂上没挂上
#
#   pwsh -File tools/host-diagnose.ps1
#
# 只读：不启动任何服务、不改任何文件。
#
# 这份脚本回答一个具体问题 —— 2026-11-27 真机上「复盘面板说读不回落盘文件、
# 项目管理说 Host 接口没挂上（HTTP 404）」到底是什么状态：
#
#   ① 插件条目活着吗（tools 里有 analyze_conversation_efficiency 吗）
#   ② host-status.json 说三桥挂上了吗（pending/skipped/mounted/error）
#   ③ 路由真的在吗（HTTP 探测，带/不带令牌）
#   ④ Host 进程是什么时候起的、源码是什么时候改的（谁比谁新）
param(
  [string]$DshHome = $env:DSH_HOME,
  [string]$WebUrl = $env:DSH_WEB_URL
)

$fail = 0
function Assert-It($name, $ok, $detail = '') {
  if ($ok) { Write-Output "  PASS  $name" }
  else { Write-Output "  FAIL  $name$(if ($detail) { " — $detail" })"; $script:fail += 1 }
}
function Note($text) { Write-Output "        $text" }

$routes = @(
  '/limbs/model-settings',
  '/limbs/review',
  '/limbs/review-bridge',
  '/limbs/handoff-config',
  '/limbs/handoff-project',
  '/limbs/handoff-bridge'
)

Write-Output '════════════════════════════════════════════════════════'
Write-Output "  dsh-limbs 真机诊断"
Write-Output "  DSH_HOME : $DshHome"
Write-Output "  Web URL  : $WebUrl"
Write-Output '════════════════════════════════════════════════════════'

# ── ④ 时间对照：谁比谁新 ──────────────────────────────────────────
Write-Output ''
Write-Output '── 时间对照（谁在跑哪个代码）──'
# ⚠️ 别只比「最早那个 DSH 进程」：桌面版是主进程 + Host worker（多个同名进程），
# 真正持有 webServer、加载插件的往往是**较晚**那个。2026-11-27 实测就是主进程
# 10:45:20、Host worker 10:45:21，源码 14:19 —— 只看主进程会把「已经热重载过」
# 误判成「没重启」。所以：所有同名进程都列，判据取**最后一笔**（Host 侧重载
# 会由 dsh-hmr 在进程内热替换，进程启动时间不变也不代表代码旧）。
$hostProcs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Sort-Object StartTime
$sourceFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'lib/host.js'
$statusFile = Join-Path $DshHome 'dsh-limbs/host-status.json'
if ($hostProcs -eq $null) {
  Write-Output '  ⚠️ 没找到 DSH 进程（可能不是桌面版在跑这个 profile）'
} else {
  foreach ($p in $hostProcs) {
    Write-Output ("  DSH 进程 pid {0,-6} 启动 {1}" -f $p.Id, $p.StartTime.ToString('yyyy-MM-dd HH:mm:ss'))
  }
  # 真正可信的判据是状态文件自己的时间戳：它是**当前跑着的 Host 半侧**写的，
  # 与进程启动时间无关。
  if (Test-Path $statusFile) {
    $writtenAt = [datetimeoffset]::FromUnixTimeMilliseconds([int64]((Get-Content $statusFile -Raw | ConvertFrom-Json).writtenAt)).LocalDateTime
    Write-Output ("  host-status 写入 : {0}" -f $writtenAt.ToString('yyyy-MM-dd HH:mm:ss'))
  }
  if (Test-Path $sourceFile) {
    Write-Output ("  lib/host.js 修改 : {0}" -f (Get-Item $sourceFile).LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
    Note '源码比进程新 ≠ 一定是旧代码：桌面版的 Host 半侧走 dsh-hmr 进程内热替换，'
    Note '进程启动时间不会变。真判据是下面 host-status 的写入时间 + pid 是不是当前活着的那个。'
  }
}

# ── ② 诊断文件 ────────────────────────────────────────────────────
Write-Output ''
Write-Output '── host-status.json（插件自己写的挂载结果）──'
if (-not (Test-Path $statusFile)) {
  Write-Output "  ⚠️ 不存在：$statusFile"
  Note '说明这份代码（带 host-status 的版本）**还没在 Host 侧跑过** —— 重启 DSH 后它才会出现。'
  Note '在此之前，下面的 ③ 才是唯一判据。'
} else {
  $status = Get-Content $statusFile -Raw | ConvertFrom-Json
  Write-Output ("  写入时间 : {0}" -f ([datetimeoffset]::FromUnixTimeMilliseconds([int64]$status.writtenAt).LocalDateTime.ToString('yyyy-MM-dd HH:mm:ss')))
  Write-Output ("  pid      : {0}" -f $status.pid)
  Write-Output ("  webServer: {0}" -f $status.webServer)
  foreach ($bridge in @('modelSettings', 'review', 'handoff')) {
    $entry = $status.bridges.$bridge
    $routeText = if ($entry.routes -and $entry.routes.Count -gt 0) { $entry.routes -join ', ' } else { '(无)' }
    Write-Output ("    {0,-14} {1,-8} {2}" -f $bridge, $entry.status, $routeText)
    if ($entry.reason) { Note ("原因：" + $entry.reason) }
  }
  if ($status.error) { Write-Output ("  最后错误 : {0}" -f $status.error) }
}

# ── ③ 路由探活 ────────────────────────────────────────────────────
Write-Output ''
Write-Output '── 路由探活（HTTP）──'
if ([string]::IsNullOrWhiteSpace($WebUrl)) {
  Write-Output '  ⚠️ 没有 DSH_WEB_URL，跳过探活。'
} else {
  Write-Output '  先看对照组：未注册的路径也必须是 404，否则「404」不能当作没挂的证据。'
  $control = Invoke-WebRequest -Uri ($WebUrl + '/zzz-not-a-route') -SkipHttpErrorCheck -TimeoutSec 5
  Assert-It '对照组 /zzz-not-a-route 是 404' ($control.StatusCode -eq 404) ("got " + $control.StatusCode)

  $mounted = 0
  foreach ($route in $routes) {
    try {
      $r = Invoke-WebRequest -Uri ($WebUrl + $route) -SkipHttpErrorCheck -TimeoutSec 5
      if ($r.StatusCode -eq 404) {
        Write-Output ("  MISS  {0,-26} 404（路由没注册）" -f $route)
      } else {
        Write-Output ("  OK    {0,-26} {1}（路由在；无令牌时 403 是正常的）" -f $route, $r.StatusCode)
        $mounted += 1
      }
    } catch {
      Write-Output ("  ERR   {0,-26} {1}" -f $route, $_.Exception.Message)
    }
  }
  Assert-It '六条 /limbs 路由不是全部 404' ($mounted -gt 0) ("已挂 $mounted / " + $routes.Count)
  if ($mounted -eq 0) {
    Note '全部 404 = 三桥一条都没挂上。对照 host-status.json 的 bridges 字段：'
    Note '  pending/skipped → 路由真的没注册（重启 DSH；若重启后仍 pending，说明 webServer 没激活）'
    Note '  mounted         → 路由在但探活打不中，问题在路径/端口（检查 DSH_WEB_URL 是否是当前端口）'
  }
}

Write-Output ''
Write-Output '════════════════════════════════════════════════════════'
if ($fail -eq 0) {
  Write-Output '总检: ✅ 没有发现「路由没挂」'
  exit 0
}
Write-Output "总检: ❌ 有 $fail 项未通过"
exit 1
