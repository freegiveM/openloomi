#requires -Version 5.1
# Admin Cleanup Script - run with elevated privileges

$ErrorActionPreference = 'SilentlyContinue'

function Get-DirSize($path) {
  if (Test-Path $path) {
    $s = (Get-ChildItem -Path $path -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    if ($s) { [math]::Round($s/1MB, 2) } else { 0 }
  } else { 0 }
}

$result = [ordered]@{}

# 1. C:\Windows\Temp
$before = Get-DirSize 'C:\Windows\Temp'
Stop-Service -Name wuauserv -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path 'C:\Windows\Temp\*' -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
$after = Get-DirSize 'C:\Windows\Temp'
$result['Windows\Temp'] = [pscustomobject]@{ Before=$before; After=$after; Freed=[math]::Round($before-$after, 2) }

# 2. Windows Update 缓存
$wuBefore = Get-DirSize 'C:\Windows\SoftwareDistribution\Download'
Get-ChildItem -Path 'C:\Windows\SoftwareDistribution\Download\*' -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
$wuAfter = Get-DirSize 'C:\Windows\SoftwareDistribution\Download'
$result['Windows Update 缓存'] = [pscustomobject]@{ Before=$wuBefore; After=$wuAfter; Freed=[math]::Round($wuBefore-$wuAfter, 2) }

# 3. Prefetch (保守清理：删除 .pf 文件，目录保留)
$pfBefore = Get-DirSize 'C:\Windows\Prefetch'
Get-ChildItem -Path 'C:\Windows\Prefetch\*.pf' -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
$pfAfter = Get-DirSize 'C:\Windows\Prefetch'
$result['Prefetch'] = [pscustomobject]@{ Before=$pfBefore; After=$pfAfter; Freed=[math]::Round($pfBefore-$pfAfter, 2) }

# 4. 回收站
$rbBefore = Get-DirSize 'C:\$Recycle.Bin'
try {
  Clear-RecycleBin -Force -ErrorAction Stop
  $rbStatus = '已清空'
} catch {
  $rbStatus = "跳过: $($_.Exception.Message)"
}
$rbAfter = Get-DirSize 'C:\$Recycle.Bin'
$result['回收站'] = [pscustomobject]@{ Before=$rbBefore; After=$rbAfter; Freed=[math]::Round($rbBefore-$rbAfter, 2); Status=$rbStatus }

# 重启 Windows Update 服务
try { Set-Service -Name wuauserv -StartupType Manual -ErrorAction SilentlyContinue; Start-Service -Name wuauserv -ErrorAction SilentlyContinue } catch {}

# 输出
$result.GetEnumerator() | ForEach-Object {
  [PSCustomObject]@{ 项目=$_.Key; 清理前MB=$_.Value.Before; 清理后MB=$_.Value.After; 释放MB=$_.Value.Freed; 备注=$_.Value.Status }
} | Format-Table -AutoSize

# 输出 JSON 汇总（供主进程读取）
$summary = ($result.GetEnumerator() | ForEach-Object {
  [pscustomobject]@{ name=$_.Key; before=$_.Value.Before; after=$_.Value.After; freed=$_.Value.Freed }
}) | ConvertTo-Json -Compress
Write-Host "JSON:$summary"
