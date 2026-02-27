Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead('dart-monitor-update.zip')
Write-Host "=== ZIP 전체 파일 수: $($z.Entries.Count) ==="
foreach ($e in $z.Entries) {
    if ($e.Name -like '*ai-space*' -or $e.Name -eq 'server.js' -or $e.Name -eq 'context.js' -or $e.Name -like '*permissions*') {
        Write-Host "$($e.FullName) ($($e.Length) bytes)"
    }
}
Write-Host ""
Write-Host "=== routes/ 폴더 파일 목록 ==="
foreach ($e in $z.Entries) {
    if ($e.FullName -like 'routes/*') {
        Write-Host "$($e.FullName) ($($e.Length) bytes)"
    }
}
$z.Dispose()
