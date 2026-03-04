import { getConfig } from "./config.js";
import { createApp } from "./app.js";
import { logger } from "./logger.js";

const config = getConfig();
const { app } = createApp(config.claudeModel);

const server = app.listen(config.port, () => {
  console.log("━".repeat(60));
  console.log("  📰 네이버 뉴스 클리퍼 (Web GUI)");
  console.log("━".repeat(60));
  console.log(`\n  🌐 http://localhost:${config.port}`);
  console.log(`  📊 모델: ${config.claudeModel}`);
  console.log(`\n  브라우저에서 위 주소를 열어주세요.\n`);
  logger.info(`웹 서버 시작: http://localhost:${config.port}`);
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
