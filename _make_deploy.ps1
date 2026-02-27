# 배포 ZIP 생성 스크립트
$ErrorActionPreference = "Stop"
$zipName = "dart-monitor-deploy.zip"

# 기존 ZIP 삭제
if (Test-Path $zipName) { Remove-Item $zipName -Force }

# 제외 패턴
$excludeDirs = @("node_modules", "data", ".git", "backup_20260222_142510", "_deploy_verified", "_deploy_extract")
$excludeExt = @(".zip", ".ps1", ".log")
$excludeFiles = @(".env", ".gitignore")

# 파일 수집
$root = (Get-Location).Path
$allFiles = Get-ChildItem -Recurse -File
$filtered = @()

foreach ($f in $allFiles) {
    $rel = $f.FullName.Substring($root.Length + 1)
    $skip = $false
    
    # 디렉토리 제외
    foreach ($d in $excludeDirs) {
        if ($rel.StartsWith("$d\") -or $rel.StartsWith("$d/")) {
            $skip = $true
            break
        }
    }
    
    # 확장자 제외
    if (-not $skip) {
        foreach ($e in $excludeExt) {
            if ($f.Extension -eq $e) { $skip = $true; break }
        }
    }
    
    # 특정 파일 제외
    if (-not $skip) {
        if ($excludeFiles -contains $f.Name) { $skip = $true }
    }
    
    if (-not $skip) { $filtered += $f }
}

Write-Host "Files: $($filtered.Count)"

# ZIP 생성
Add-Type -Assembly System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$root\$zipName", 'Create')

foreach ($f in $filtered) {
    $entryName = $f.FullName.Substring($root.Length + 1).Replace("\", "/")
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $entryName) | Out-Null
}

$zip.Dispose()

$zipInfo = Get-Item $zipName
Write-Host "ZIP created: $zipName ($($zipInfo.Length) bytes)"

# 핵심 파일 검증
$checkZip = [System.IO.Compression.ZipFile]::OpenRead("$root\$zipName")
$serverEntry = $checkZip.Entries | Where-Object { $_.FullName -eq "server.js" }
$aiEntry = $checkZip.Entries | Where-Object { $_.FullName -eq "routes/ai-space.js" }

if ($serverEntry) {
    Write-Host "server.js: $($serverEntry.Length) bytes"
}
else {
    Write-Host "ERROR: server.js not found in ZIP!"
}

if ($aiEntry) {
    Write-Host "ai-space.js: $($aiEntry.Length) bytes"
}
else {
    Write-Host "ERROR: ai-space.js not found in ZIP!"
}

$checkZip.Dispose()
Write-Host "Done"
