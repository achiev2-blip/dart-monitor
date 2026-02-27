# 디버그: 포함/제외 파일 확인
$excluded = @()
$included = @()
$files = Get-ChildItem -Recurse -File
foreach ($f in $files) {
    $match = $f.FullName -notmatch '\\(node_modules|\.git[\/\\]|backup_)'
    $extOk = $f.Extension -ne '.log'
    $nameOk = $f.Name -ne 'dart-monitor-update.zip'
    if ($match -and $extOk -and $nameOk) {
        $included += $f.FullName
    }
    else {
        $excluded += "$($f.FullName) | match:$match ext:$extOk name:$nameOk"
    }
}

Write-Host "=== 포함: $($included.Count)개 ==="
$included | Where-Object { $_ -like '*ai-space*' -or $_ -like '*permissions*' -or $_ -like '*context.js' } | ForEach-Object { Write-Host $_ }
Write-Host ""
Write-Host "=== 제외 중 routes 관련 ==="
$excluded | Where-Object { $_ -like '*routes*' } | ForEach-Object { Write-Host $_ }
Write-Host ""
Write-Host "=== 제외 중 utils 관련 ==="
$excluded | Where-Object { $_ -like '*utils*' } | ForEach-Object { Write-Host $_ }
