/**
 * DART 모니터 — 환경 설정
 * 
 * 모든 설정값을 .env에서 로드하여 제공
 * 서버 이전 시 .env만 수정하면 됨
 */
require('dotenv').config();
const path = require('path');

module.exports = {
  PORT: parseInt(process.env.PORT) || 3000,
  DATA_DIR: process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, 'data'),

  DART_API_KEY: process.env.DART_API_KEY || '',
  GEMINI_KEY: process.env.GEMINI_KEY || '',
  INTERNAL_API_KEY: process.env.INTERNAL_API_KEY || 'dartmonitor-2024',
  CLAUDE_API_KEY: process.env.CLAUDE_API_KEY || 'dartmonitor-claude',   // Claude AI 전용 인증키
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || 'dartmonitor-gemini',   // Gemini AI 전용 인증키

  HANTOO_APP_KEY: process.env.HANTOO_APP_KEY || '',
  HANTOO_APP_SECRET: process.env.HANTOO_APP_SECRET || '',

  // Gemini 모델 폴백 체인 (2026-02-27 새 키 검증 완료)
  GEMINI_BASE: 'https://generativelanguage.googleapis.com/v1beta/models/',
  GEMINI_MODELS: [
    { id: 'gemini-2.5-flash', label: 'Pro Flash' },
    { id: 'gemini-2.5-flash-lite', label: 'Pro Lite' },
  ],

  COOLDOWN_MS: 60 * 60000,  // 1시간
  MEMORY_LIMIT_MB: 500,

  // 타임존 (서버 이전 시에도 한국시간 기준)
  TIMEZONE: 'Asia/Seoul'
};
