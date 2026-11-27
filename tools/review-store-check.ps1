# 模块三 · 复盘报告落盘的真机复查（重启 DSH 后跑一次复盘，再运行本脚本）。
#
#   pwsh -File tools/review-store-check.ps1
#
# 只读：只列目录、读最新一份、断言内容与份数，不改任何文件。
# 判据（全 True 才算 B2 在真机上成立）：
#   ① 目录存在且至少有 1 份（= 复盘真的落盘了）
#   ② 最新那份正文含「最该做的三条」（= A1 置顶进了报告）
#   ③ 正文含「### 一、总账」（= 第六章全文与章节号没被顶乱）
#   ④ 份数 ≤ 20（= 清理策略生效）
#   ⑤ 正文开头不是 frontmatter（= 正文保持纯报告，时间取自 mtime）
param(
  [string]$DshHome = $env:DSH_HOME,
  [int]$KeepCount = 20
)

$reviews = Join-Path $DshHome 'dsh-limbs/reviews'
$fail = 0
function Assert-It($name, $ok, $detail = '') {
  if ($ok) { Write-Output "  PASS  $name" }
  else { Write-Output "  FAIL  $name$(if ($detail) { " — $detail" })"; $script:fail += 1 }
}

Write-Output "落点：$reviews"
Write-Output ('=' * 52)

$exists = Test-Path $reviews
Assert-It '① 报告目录存在' $exists $reviews
if (-not $exists) {
  Write-Output ''
  Write-Output '总检: ❌ 目录都不存在 —— 复盘还没落盘。'
  Write-Output '      多半是 Host 半侧没重启（改 lib/host.js 必须重启 DSH，刷新页面不算）。'
  exit 1
}

$files = Get-ChildItem $reviews -Filter *.md -File | Sort-Object LastWriteTime -Descending
Assert-It '① 至少有 1 份报告（复盘已落盘）' ($files.Count -ge 1) ("共 $($files.Count) 份")
if ($files.Count -eq 0) {
  Write-Output ''
  Write-Output '总检: ❌ 目录在、但一份都没有 —— 复盘没走到落盘，或当前会话是 read-only。'
  exit 1
}

$latest = $files[0]
Write-Output ("  最新一份：{0}  ({1} B, mtime {2})" -f $latest.Name, $latest.Length,
  $latest.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
$text = Get-Content $latest.FullName -Raw

Assert-It '② 正文含「最该做的三条」（A1）' ($text -match '### 最该做的') '没找到置顶小节'
Assert-It '③ 正文含「### 一、总账」（章节号没被顶乱）' ($text -match '### 一、总账') '章节序号变了'
Assert-It '④ 份数 ≤ 保留上限' ($files.Count -le $KeepCount) ("$($files.Count) > $KeepCount")
Assert-It '⑤ 正文保持纯报告（无 frontmatter）' (-not ($text.StartsWith('---'))) '开头是 ---'

Write-Output ''
Write-Output ("份数：{0}（上限 {1}）" -f $files.Count, $KeepCount)
if ($fail -eq 0) {
  Write-Output '总检: ✅ B2 在真机上成立'
  exit 0
}
Write-Output "总检: ❌ 有 $fail 项未通过"
exit 1
