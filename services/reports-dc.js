/**
 * 리포트 전용 DC — DC의 reports 섹션 독립 관리
 * 
 * 역할:
 *  1. app.locals.reportStores에서 리포트 읽기
 *  2. dc.reports에 누적 관리 (50건 캡)
 *  3. 자체 5분 타이머로 독립 갱신
 *  4. getReportData() — 리포트 데이터 제공
 * 
 * 이전: context.js updateClaudeSummary L1047-1062
 */

const DC_REPORT_CAP = 50;

// ── 상태 ──
let _app = null;
let lastUpdatedAt = null;
let sentReportIds = new Set();  // DC에 이미 넣은 리포트 ID 기억

// ════════════════════════════════════════════════
// DC 리포트 관리 — dc.reports 독립 갱신
// ════════════════════════════════════════════════

/** DC의 reports 섹션 갱신 — reportStores에서 새 리포트만 누적 (sentIds로 중복 방지) */
function updateReports() {
    if (!_app) return;

    // DC 초기화 보장
    if (!_app.locals.claudeDataCenter) {
        _app.locals.claudeDataCenter = { ok: true, news: [], reports: [], disclosures: [], _meta: {} };
    }
    const dc = _app.locals.claudeDataCenter;
    const reportStores = _app.locals.reportStores;

    if (!reportStores) return;

    try {
        // 모든 소스에서 리포트 수집
        const allReports = [];
        Object.values(reportStores).forEach(items => allReports.push(...items));

        // sentReportIds로 이미 DC에 넣은 리포트 건너뜀
        const newReports = allReports.filter(r => {
            const id = (r.title || '') + (r.date || '');
            return !sentReportIds.has(id);
        }).map(r => ({
            title: r.title, broker: r.broker || r.source,
            date: r.date, opinion: r.opinion || '',
            stock: r.stockName || r.corp || ''
        }));

        // 누적 + 정렬 + 캡 적용
        if (newReports.length > 0) {
            dc.reports = [...(dc.reports || []), ...newReports]
                .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
                .slice(0, DC_REPORT_CAP);
            // 새로 넣은 ID 기억
            newReports.forEach(r => sentReportIds.add(r.title + r.date));
        }

        // sentIds 메모리 관리: 500개 초과 시 오래된 것 삭제
        if (sentReportIds.size > 500) {
            const arr = [...sentReportIds];
            sentReportIds = new Set(arr.slice(-250));
        }

        lastUpdatedAt = new Date().toISOString();
        console.log(`[reports-dc/DC] 갱신: ${dc.reports.length}건 (신규 ${newReports.length}건)`);

    } catch (e) {
        console.warn(`[reports-dc/DC] 갱신 실패: ${e.message}`);
    }
}

// ════════════════════════════════════════════════
// 외부 인터페이스
// ════════════════════════════════════════════════

/** 리포트 데이터 반환 */
function getReportData() {
    if (_app && _app.locals.claudeDataCenter) {
        return _app.locals.claudeDataCenter.reports || [];
    }
    return [];
}

// ════════════════════════════════════════════════
// 초기화 — server.js에서 호출
// ════════════════════════════════════════════════

/** reports-dc 초기화 */
function init(app) {
    _app = app;

    console.log('[reports-dc] 초기화 시작');

    // DC 갱신 (15초 후 첫 실행, 이후 5분마다)
    setTimeout(() => updateReports(), 15000);
    setInterval(() => updateReports(), 300000);

    console.log('[reports-dc] DC 갱신 타이머 시작 (5분)');
    console.log('[reports-dc] 초기화 완료');
}

/** 상태 조회 */
function getStatus() {
    return {
        lastUpdatedAt,
        reportCount: _app?.locals?.claudeDataCenter?.reports?.length || 0
    };
}

module.exports = { init, getReportData, getStatus, updateReports };
