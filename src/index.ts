import { getConfig } from "./config.js";
import { createApp } from "./app.js";
import { logger } from "./logger.js";
import open from "open";

const config = getConfig();
const { app } = createApp(config.claudeModel);

const server = app.listen(config.port, () => {
  const url = `http://localhost:${config.port}`;

  console.log();
  console.log("━".repeat(60));
  console.log("  📰 네이버 뉴스 클리퍼 (Web GUI)");
  console.log("━".repeat(60));
  console.log();
  console.log(`  🌐 주소: ${url}`);
  console.log(`  🤖 모델: ${config.claudeModel}`);
  console.log(`  🔑 Anthropic API: ${process.env.ANTHROPIC_API_KEY ? "✅ 설정됨" : "❌ 미설정"}`);
  console.log(`  🔍 네이버 API:    ${process.env.NAVER_CLIENT_ID ? "✅ 설정됨" : "⚠️  미설정 (스크래핑 모드)"}`);
  console.log();
  console.log("  ─── 사용법 ───────────────────────────────────────────");
  console.log("  1. 브라우저에서 위 주소를 열어주세요 (자동으로 열립니다)");
  console.log("  2. 검색 키워드와 기간을 입력 → 검색");
  console.log("  3. 기사를 선택 → 분석 시작 → DOCX 다운로드");
  console.log();
  console.log("  ─── 명령어 가이드 ────────────────────────────────────");
  console.log("  npm start          서버 실행 (기본 포트 3000)");
  console.log("  npm run dev        개발 모드 (파일 변경 시 자동 재시작)");
  console.log("  npm run build      TypeScript 빌드 (dist/ 생성)");
  console.log("  PORT=3001 npm start  포트 변경하여 실행");
  console.log();
  console.log("  ─── 환경 설정 (.env) ─────────────────────────────────");
  console.log("  ANTHROPIC_API_KEY   Claude API 키 (필수)");
  console.log("  CLAUDE_MODEL        모델명 (기본: claude-opus-4-6)");
  console.log("  NAVER_CLIENT_ID     네이버 API Client ID (권장)");
  console.log("  NAVER_CLIENT_SECRET 네이버 API Client Secret (권장)");
  console.log();
  console.log("━".repeat(60));
  console.log();

  logger.info(`웹 서버 시작: ${url}`);

  open(url).catch(() => {
    console.log("  ⚠️  브라우저를 자동으로 열 수 없습니다. 위 URL을 직접 열어주세요.");
  });
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ 포트 ${config.port}이 이미 사용 중입니다.`);
    console.error(`   PORT=3001 npm start 로 다른 포트를 사용하세요.\n`);
  } else {
    console.error("\n❌ 서버 시작 실패:", err.message);
  }
  process.exit(1);
});
