---
description: GCP VM에 코드 배포하는 방법
---
# GCP 배포 워크플로우

## 서버 정보
- **IP**: 34.22.94.45
- **접속**: http://34.22.94.45
- **PM2 프로세스명**: dart-monitor
- **VM 경로**: ~/dart-monitor
- **GCP 프로젝트**: gen-lang-client-0289807056 (Default Gemini Project)
- **존/인스턴스**: asia-northeast3-b / instance-20260223-054504
- **SSH 바로가기**: `vm-ssh.bat` 더블클릭 또는 아래 명령어

```powershell
// turbo
gcloud compute ssh instance-20260223-054504 --project=gen-lang-client-0289807056 --zone=asia-northeast3-b
```

## 소규모 변경 (파일 1~2개)

1. VM SSH 열기: `vm-ssh.bat` 더블클릭 또는 터미널에서:
// turbo
```powershell
gcloud compute ssh instance-20260223-054504 --project=gen-lang-client-0289807056 --zone=asia-northeast3-b
```
2. nano로 직접 수정:
```bash
cd ~/dart-monitor
nano <파일경로>
```
3. 저장 후 재시작:
```bash
pm2 restart dart-monitor
```

## 대규모 변경 (파일 여러 개)

1. 로컬에서 zip 생성 (디렉토리 구조 유지):
// turbo
```powershell
cd d:\dart-monitor\dart-monitor
powershell -Command "Remove-Item dart-monitor-update.zip -ErrorAction SilentlyContinue; $files = Get-ChildItem -Recurse -File | Where-Object { $_.FullName -notmatch '\\\\(node_modules|\\.git[\\\\\\/]|backup_)' -and $_.Extension -ne '.log' -and $_.Name -ne 'dart-monitor-update.zip' }; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::Open('dart-monitor-update.zip','Create'); $base = (Get-Location).Path + '\\'; foreach($f in $files){ $rel = $f.FullName.Substring($base.Length).Replace('\\','/'); [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$f.FullName,$rel)|Out-Null }; $zip.Dispose(); Write-Host ('ZIP created: ' + (Get-Item dart-monitor-update.zip).Length + ' bytes')"
```
> ⚠️ `Compress-Archive`는 디렉토리 구조를 보존하지 않고, `.NET ZipFile`은 백슬래시를 사용하므로 `.Replace('\','/')`로 변환 필수.

2. GCP SSH 창에서 "파일 업로드" (⚙️ 메뉴) → dart-monitor-update.zip 선택
3. VM에서 압축 해제 및 재시작:
```bash
cd ~
unzip -o dart-monitor-update.zip -d dart-monitor
cd dart-monitor
pm2 restart dart-monitor
```

## PM2 유용한 명령어
```bash
pm2 status          # 상태 확인
pm2 logs            # 로그 보기
pm2 restart dart-monitor  # 재시작
pm2 stop dart-monitor     # 중지
pm2 monit           # 모니터링
```
