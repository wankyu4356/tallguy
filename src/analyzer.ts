import Anthropic from "@anthropic-ai/sdk";
import type { ArticleDetail, RankedArticle } from "./types.js";

export async function rankByImportance(
  articles: ArticleDetail[],
  claude: Anthropic,
  model: string,
): Promise<RankedArticle[]> {
  console.log("📊 기사 중요도 분석 중...");

  // 기사 요약 목록 생성 (토큰 절약을 위해 본문은 앞부분만)
  const articleSummaries = articles.map((a, i) => ({
    index: i,
    title: a.title,
    press: a.press,
    date: a.publishDate,
    bodyPreview: a.body.slice(0, 500),
  }));

  const response = await claude.messages.create({
    model,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `당신은 M&A(인수합병) 전문 애널리스트입니다. 아래 뉴스 기사 목록을 M&A 관점에서 중요도 순으로 랭킹해주세요.

중요도 기준:
1. M&A 직접 관련 (인수, 합병, 매각, 지분 투자 등) → 가장 높음
2. 기업 가치평가, 자금조달, IPO 등 M&A에 영향을 미치는 이벤트
3. 산업 재편, 규제 변화 등 M&A 환경에 영향을 미치는 뉴스
4. 일반 기업/경제 뉴스 → 가장 낮음

각 기사의 중요도를 1(가장 중요)부터 매겨주세요. 동일 중요도 가능합니다.

반드시 아래 JSON 형식으로만 응답하세요:
[
  { "index": 0, "importance": 1, "reason": "중요도 판단 이유 (한 줄)" },
  ...
]

기사 목록:
${JSON.stringify(articleSummaries, null, 2)}`,
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const jsonMatch = text.match(/\[[\s\S]*\]/);

  let rankings: { index: number; importance: number; reason: string }[];
  try {
    if (!jsonMatch) throw new Error("JSON not found");
    rankings = JSON.parse(jsonMatch[0]);
  } catch {
    // 파싱 실패 시 순서 유지
    rankings = articles.map((_, i) => ({ index: i, importance: i + 1, reason: "분석 불가" }));
  }

  // 인덱스 매핑
  const rankMap = new Map(rankings.map((r) => [r.index, r]));

  const rankedArticles: RankedArticle[] = articles.map((article, i) => {
    const rank = rankMap.get(i) || { importance: 999, reason: "분석 불가" };
    return {
      ...article,
      importance: rank.importance,
      importanceReason: rank.reason,
    };
  });

  // 중요도 순으로 정렬
  rankedArticles.sort((a, b) => a.importance - b.importance);

  console.log("   ✅ 중요도 분석 완료\n");
  return rankedArticles;
}

export async function generateExecutiveSummary(
  articles: RankedArticle[],
  keyword: string,
  claude: Anthropic,
  model: string,
): Promise<string[]> {
  console.log("📝 Executive Summary 생성 중...");

  const articleList = articles
    .map(
      (a, i) =>
        `${i + 1}. [${a.press}] ${a.title} (${a.publishDate})\n   ${a.body.slice(0, 300)}...`,
    )
    .join("\n\n");

  const response = await claude.messages.create({
    model,
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `당신은 M&A 전문 애널리스트입니다. 아래 뉴스 기사들을 종합하여 Executive Summary를 작성해주세요.

요구사항:
- "${keyword}" 관련 주요 동향을 10줄 내외의 bullet point로 정리
- M&A 관점에서 가장 중요한 이슈부터 나열
- 각 bullet은 핵심 내용을 간결하게 담을 것
- 한국어로 작성

반드시 아래 형식으로만 응답하세요 (각 줄이 하나의 bullet):
• 첫 번째 요점
• 두 번째 요점
...

기사 목록 (중요도 순):
${articleList}`,
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const bullets = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("•") || line.startsWith("-") || line.startsWith("·"))
    .map((line) => line.replace(/^[•\-·]\s*/, "").trim());

  console.log("   ✅ Executive Summary 생성 완료\n");
  return bullets;
}
