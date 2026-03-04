import { Command } from "commander";
import dotenv from "dotenv";
import type { ClipperConfig } from "./types.js";

dotenv.config();

export function parseConfig(): ClipperConfig {
  const program = new Command();

  program
    .name("naver-news-clipper")
    .description("네이버 뉴스 클리핑 도구")
    .requiredOption("-k, --keyword <keyword>", "검색 키워드 (정확히 일치 검색)")
    .option("-d, --days <days>", "검색 기간 (일)", "7")
    .option("-o, --output <path>", "출력 DOCX 파일 경로", "")
    .option("-m, --model <model>", "Claude 모델", process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514")
    .option("-p, --port <port>", "웹 UI 포트", "3000")
    .parse();

  const opts = program.opts();

  const today = new Date();
  const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  const defaultOutput = `뉴스클리핑_${opts.keyword}_${dateStr}.docx`;

  return {
    keyword: opts.keyword,
    days: parseInt(opts.days, 10),
    outputPath: opts.output || defaultOutput,
    claudeModel: opts.model,
    port: parseInt(opts.port, 10),
  };
}
