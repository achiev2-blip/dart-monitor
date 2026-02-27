# 🔗 dartmonitor.com 도메인 연결 (1분 작업)

## 현재 상태
- ✅ GCP VM 배포 완료: http://34.22.94.45
- ❌ 도메인 연결 미완료

## 해야 할 것
1. https://dash.cloudflare.com 접속
2. **dartmonitor.com** 클릭
3. 왼쪽 메뉴 → **DNS** → **Records**
4. **Add record** 클릭:
   - Type: `A`
   - Name: `@`
   - IPv4 address: `34.22.94.45`
   - Proxy status: **Proxied** (주황색 구름 ☁️)
5. Save

## 완료되면
- `http://dartmonitor.com` 으로 접속 가능!
- 이 파일 삭제해도 됨
