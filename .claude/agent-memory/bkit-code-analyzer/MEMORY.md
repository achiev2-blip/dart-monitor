# Code Analyzer Memory - dart-monitor

## Project Profile
- **Type**: Node.js local web app (Express + Cheerio + Puppeteer-core + Axios)
- **Structure**: Monolithic single-file (server.js ~2723 lines, index.html ~1984 lines)
- **Quality Score**: 32/100 (as of 2026-02-20)

## Critical Issues Identified
1. **Hardcoded secrets**: DART API key, Gemini API key, internal API key, Telegram bot token all in source
2. **CORS wildcard**: `Access-Control-Allow-Origin: *` with localhost-based auth bypass
3. **No rate limiting**, no input validation, unauthenticated shutdown/restore APIs
4. **Sync file I/O** blocking event loop (writeFileSync/readFileSync)
5. **Unbounded caches**: reportAiCache, reportCache grow without limit

## Architecture Notes
- 6 RSS news sources with near-identical parsing functions (DRY violation, ~210 lines duplicated)
- 5 broker report crawlers in single if/else chain inside `fetchReportPage()` (~320 lines)
- ~30 global `let` variables for state management
- Puppeteer instances created/destroyed per request (no pooling)
- Frontend uses raw XHR + manual DOM manipulation (no framework)

## Analysis Output
- Full report: `docs/03-analysis/code-quality.analysis.md`
- Recommended modular structure provided in the report (Section 5.2)
- 4-phase improvement roadmap: Security > Structure > Stability > Testing
