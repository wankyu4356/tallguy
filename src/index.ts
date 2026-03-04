import Anthropic from "@anthropic-ai/sdk";
import { parseConfig } from "./config.js";
import { scrapeNaverNews } from "./scraper.js";
import { startSelectionServer } from "./server.js";
import { extractAllArticles } from "./extractor.js";
import { rankByImportance, generateExecutiveSummary } from "./analyzer.js";
import { generateDocx } from "./docxGenerator.js";
import type { ClipperReport, SearchArticle } from "./types.js";

async function main() {
  console.log("━".repeat(60));
  console.log("  📰 네이버 뉴스 클리퍼");
  console.log("━".repeat(60));

  // 1. 설정 파싱
  const config = parseConfig();
  console.log(`\n⚙️  설정:`);
  console.log(`   키워드: "${config.keyword}"`);
  console.log(`   기간: 최근 ${config.days}일`);
  console.log(`   출력: ${config.outputPath}`);
  console.log(`   모델: ${config.claudeModel}`);

  // 2. Anthropic 클라이언트 초기화
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("\n❌ ANTHROPIC_API_KEY 환경 변수가 설정되지 않았습니다.");
    console.error("   .env 파일에 ANTHROPIC_API_KEY=your-key-here 를 추가하세요.");
    process.exit(1);
  }

  const claude = new Anthropic();

  // 3. 네이버 뉴스 검색
  const allArticles = await scrapeNaverNews(config.keyword, config.days);

  if (allArticles.length === 0) {
    console.log("❌ 검색 결과가 없습니다. 키워드나 기간을 조정해보세요.");
    process.exit(0);
  }

  // 4. Human-in-the-loop: 기사 선택
  console.log("📋 기사 선택 UI를 시작합니다...");
  const selectedIndices = await startSelectionServer(allArticles, config.keyword, config.port);

  const selectedArticles: SearchArticle[] = selectedIndices.map((i) => allArticles[i]);
  console.log(`\n✅ ${selectedArticles.length}건의 기사가 선택되었습니다.`);

  if (selectedArticles.length === 0) {
    console.log("❌ 선택된 기사가 없습니다. 종료합니다.");
    process.exit(0);
  }

  // 5. 기사 본문 추출 (Claude 사용)
  const articleDetails = await extractAllArticles(selectedArticles, claude, config.claudeModel);

  // 6. 중요도 분석 (M&A 기준)
  const rankedArticles = await rankByImportance(articleDetails, claude, config.claudeModel);

  // 7. Executive Summary 생성
  const executiveSummary = await generateExecutiveSummary(
    rankedArticles,
    config.keyword,
    claude,
    config.claudeModel,
  );

  // 8. DOCX 리포트 생성
  const report: ClipperReport = {
    config,
    executiveSummary,
    articles: rankedArticles,
    generatedAt: new Date().toISOString(),
  };

  const outputPath = await generateDocx(report);

  // 완료
  console.log("━".repeat(60));
  console.log("  ✅ 뉴스 클리핑이 완료되었습니다!");
  console.log(`  📄 리포트: ${outputPath}`);
  console.log(`  📊 기사 수: ${rankedArticles.length}건`);
  console.log("━".repeat(60));
}

main().catch((error) => {
  console.error("\n❌ 오류가 발생했습니다:", error);
  process.exit(1);
});
