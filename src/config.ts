import dotenv from "dotenv";

dotenv.config();

export function getConfig() {
  const port = parseInt(process.env.PORT || "3000", 10);
  const claudeModel = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("\n❌ ANTHROPIC_API_KEY 환경 변수가 설정되지 않았습니다.");
    console.error("   .env 파일에 ANTHROPIC_API_KEY=your-key-here 를 추가하세요.");
    process.exit(1);
  }

  return { port, claudeModel };
}
