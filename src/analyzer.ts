import Anthropic from "@anthropic-ai/sdk";
import type { ArticleDetail, RankedArticle, SearchArticle } from "./types.js";
import type { ProgressCallback } from "./extractor.js";
import { claudeCreate } from "./claudeHelper.js";

const BATCH_SIZE = 30;
const DEDUP_BATCH_SIZE = 100;

/** LLM으로 같은 사건을 다룬 중복 기사를 걸러낸다 (각 그룹에서 대표 1건만 유지) */
export async function filterDuplicates(
  articles: SearchArticle[],
  claude: Anthropic,
  model: string,
  onProgress?: ProgressCallback,
): Promise<SearchArticle[]> {
  if (articles.length < 2) return articles;

  console.log(`🔍 중복 기사 선별 중... (${articles.length}건)`);

  // 제목 기준 정렬 → 유사 기사가 같은 배치에 묶이도록
  const indexed = articles.map((a, i) => ({ a, i }));
  indexed.sort((x, y) => x.a.title.localeCompare(y.a.title, "ko"));

  const batches: { a: SearchArticle; i: number }[][] = [];
  for (let i = 0; i < indexed.length; i += DEDUP_BATCH_SIZE) {
    batches.push(indexed.slice(i, i + DEDUP_BATCH_SIZE));
  }

  const removeSet = new Set<number>();

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    onProgress?.(batchIdx + 1, batches.length, `중복 검사 배치 ${batchIdx + 1}/${batches.length}`);

    const list = batch.map((item, localIdx) => ({
      id: localIdx,
      title: item.a.title,
      press: item.a.press,
      date: item.a.date,
      summary: (item.a.summary || "").slice(0, 150),
    }));

    try {
      const response = await claudeCreate(claude, {
        model,
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: `아래 뉴스 기사 목록에서 "같은 사건/내용"을 다룬 중복 기사를 찾아주세요.
같은 사건을 여러 언론사가 보도한 경우도 중복입니다. 각 중복 그룹에서 가장 상세해 보이는 기사 1건만 남기고 나머지는 제거 대상입니다.
단순히 주제가 비슷한 것만으로는 중복이 아닙니다. 확실한 경우만 제거하세요.

반드시 아래 JSON 형식으로만 응답하세요 (제거할 기사의 id 배열, 없으면 빈 배열):
{ "remove": [3, 7, 12] }

기사 목록:
${JSON.stringify(list, null, 2)}`,
          },
        ],
      });

      const text = response.content[0].type === "text" ? response.content[0].text : "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { remove?: number[] };
        for (const localIdx of parsed.remove || []) {
          if (typeof localIdx === "number" && localIdx >= 0 && localIdx < batch.length) {
            removeSet.add(batch[localIdx].i);
          }
        }
      }
    } catch (error) {
      // 실패한 배치는 제거 없이 통과
      console.error(`\n   ⚠️  중복 검사 실패 (배치 ${batchIdx + 1}): ${error instanceof Error ? error.message : error}`);
    }
  }

  const filtered = articles.filter((_, i) => !removeSet.has(i));
  console.log(`   ✅ 중복 ${articles.length - filtered.length}건 제거 (${articles.length} → ${filtered.length})\n`);
  return filtered;
}

export async function rankByImportance(
  articles: ArticleDetail[],
  claude: Anthropic,
  model: string,
  analysisPrompt?: string,
  onProgress?: ProgressCallback,
): Promise<RankedArticle[]> {
  console.log("📊 기사 중요도 분석 중...");

  let allRankings: { index: number; importance: number; reason: string }[] = [];

  // Issue 8: 기사를 배치로 나누어 처리
  const batches: ArticleDetail[][] = [];
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    batches.push(articles.slice(i, i + BATCH_SIZE));
  }

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const offset = batchIdx * BATCH_SIZE;

    if (batches.length > 1) {
      process.stdout.write(`\r   배치 ${batchIdx + 1}/${batches.length} 분석 중...`);
    }
    onProgress?.(batchIdx + 1, batches.length, `배치 ${batchIdx + 1}/${batches.length} 분석`);

    const articleSummaries = batch.map((a, i) => ({
      index: i,
      title: a.title,
      press: a.press,
      date: a.publishDate,
      bodyPreview: a.body.slice(0, 500),
    }));

    // Issue 4: Claude API 에러 핸들링
    try {
      let systemInstruction: string;
      if (analysisPrompt) {
        systemInstruction = `당신은 뉴스 분석 전문가입니다. 아래 뉴스 기사 목록을 사용자가 제시한 분석 기준에 따라 중요도 순으로 랭킹해주세요.

사용자 분석 기준:
"${analysisPrompt}"

위 기준에 가장 부합하는 기사일수록 높은 중요도(낮은 숫자)를 부여하세요.
각 기사의 중요도를 1(가장 중요)부터 매겨주세요. 동일 중요도 가능합니다.`;
      } else {
        systemInstruction = `당신은 뉴스 분석 전문가입니다. 아래 뉴스 기사 목록을 뉴스 중요도 순으로 랭킹해주세요.

중요도 기준:
1. 사회적 파급력이 큰 뉴스 → 가장 높음
2. 산업·경제에 영향을 미치는 주요 이벤트
3. 기업 관련 중요 뉴스
4. 일반 뉴스 → 가장 낮음

각 기사의 중요도를 1(가장 중요)부터 매겨주세요. 동일 중요도 가능합니다.`;
      }

      const response = await claudeCreate(claude, {
        model,
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: `${systemInstruction}

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

      if (jsonMatch) {
        const batchRankings = JSON.parse(jsonMatch[0]) as {
          index: number;
          importance: number;
          reason: string;
        }[];
        // 글로벌 인덱스로 변환
        for (const r of batchRankings) {
          allRankings.push({ index: r.index + offset, importance: r.importance, reason: r.reason });
        }
      } else {
        throw new Error("JSON not found in response");
      }
    } catch (error) {
      console.error(`\n   ⚠️  중요도 분석 실패 (배치 ${batchIdx + 1}): ${error instanceof Error ? error.message : error}`);
      // 실패 시 원래 순서 유지
      for (let i = 0; i < batch.length; i++) {
        allRankings.push({ index: i + offset, importance: 999, reason: "분석 불가" });
      }
    }
  }

  // 인덱스 매핑
  const rankMap = new Map(allRankings.map((r) => [r.index, r]));

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

  console.log("\n   ✅ 중요도 분석 완료\n");
  return rankedArticles;
}

export async function generateExecutiveSummary(
  articles: RankedArticle[],
  keyword: string,
  claude: Anthropic,
  model: string,
  analysisPrompt?: string,
): Promise<string[]> {
  console.log("📝 Executive Summary 생성 중...");

  // Issue 8: 기사 많을 때 앞부분만 사용
  const topArticles = articles.slice(0, 50);
  const articleList = topArticles
    .map(
      (a, i) =>
        `${i + 1}. [${a.press}] ${a.title} (${a.publishDate})\n   ${a.body.slice(0, 300)}...`,
    )
    .join("\n\n");

  // Issue 4: Claude API 에러 핸들링
  try {
    const response = await claudeCreate(claude, {
      model,
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `당신은 뉴스 분석 전문가입니다. 아래 뉴스 기사들을 종합하여 Executive Summary를 작성해주세요.

요구사항:
- "${keyword}" 관련 주요 동향을 10줄 내외의 bullet point로 정리
- ${analysisPrompt ? `사용자 분석 관점: "${analysisPrompt}" — 이 관점에서 가장 중요한 이슈부터 나열` : "가장 중요한 이슈부터 나열"}
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

    // Issue 9: 더 많은 bullet 형식 지원
    const bullets = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[•\-·▪▸►☞✓✔⦁]/.test(line) || /^\d+[\.\)]\s/.test(line))
      .map((line) => line.replace(/^[•\-·▪▸►☞✓✔⦁]\s*/, "").replace(/^\d+[\.\)]\s*/, "").trim())
      .filter((line) => line.length > 0);

    // Issue 9: 빈 배열 폴백
    if (bullets.length === 0) {
      console.log("   ⚠️  Summary bullet 파싱 실패, 전체 응답을 줄 단위로 사용합니다.");
      const fallbackLines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 10)
        .slice(0, 10);

      if (fallbackLines.length > 0) {
        console.log("   ✅ Executive Summary 생성 완료\n");
        return fallbackLines;
      }

      console.log("   ✅ Executive Summary 생성 완료 (기본 메시지)\n");
      return [`"${keyword}" 관련 뉴스 ${articles.length}건이 수집되었습니다. 상세 내용은 기사 본문을 참고하세요.`];
    }

    console.log("   ✅ Executive Summary 생성 완료\n");
    return bullets;
  } catch (error) {
    console.error(`   ⚠️  Executive Summary 생성 실패: ${error instanceof Error ? error.message : error}`);
    return [`"${keyword}" 관련 뉴스 ${articles.length}건이 수집되었습니다. Executive Summary 자동 생성에 실패하여 기사 본문을 직접 참고해주세요.`];
  }
}
