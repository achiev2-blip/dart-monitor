# ZIP 생성 — 모든 파일 포함 확인
Remove-Item dart-monitor-update.zip -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::Open('dart-monitor-update.zip', 'Create')
$base = (Get-Location).Path + '\'
$count = 0
$critical = @('server.js', 'ai-space.js', 'context.js', 'permissions.js')

Get-ChildItem -Recurse -File | ForEach-Object {
    $full = $_.FullName
    # 제외 목록: node_modules, .git 디렉터리, backup_ 폴더, 로그, ZIP 자체, 임시 스크립트
    if ($full -match '\\node_modules\\') { return }
    if ($full -match '\\.git\\') { return }
    if ($full -match '\\backup_') { return }
    if ($_.Extension -eq '.log') { return }
    if ($_.Name -eq 'dart-monitor-update.zip') { return }
    if ($_.Name -match '^(check-zip|debug-zip|make-zip)\.ps1$') { return }
    
    $rel = $full.Substring($base.Length).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $full, $rel) | Out-Null
    $count++
    
    # 핵심 파일 확인
    if ($critical -contains $_.Name) {
        Write-Host "[포함] $rel ($($_.Length) bytes)"
    }
}

$zip.Dispose()
$zipSize = (Get-Item 'dart-monitor-update.zip').Length
Write-Host ""
Write-Host "ZIP 완료: $count개 파일, $zipSize bytes"
