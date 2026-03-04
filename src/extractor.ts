import Anthropic from "@anthropic-ai/sdk";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { fetchArticleHtml } from "./scraper.js";
import type { ArticleDetail, SearchArticle } from "./types.js";

// Issue 13: cheerio를 한 번만 파싱하여 재사용
function parseHtml(html: string): CheerioAPI {
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer, iframe, .ad, .advertisement, #comment, .comment").remove();
  return $;
}

function extractTextFromParsed($: CheerioAPI): string {
  // 네이버 뉴스 본문 우선 추출 시도
  const naverArticle = $("#dic_area, #newsct_article, #articeBody, #articleBodyContents").first();
  if (naverArticle.length > 0) {
    return naverArticle.text().replace(/\s+/g, " ").trim();
  }

  // 일반적인 기사 본문 영역 시도
  const articleBody = $("article, .article-body, .article_body, .news_end, #article-body").first();
  if (articleBody.length > 0) {
    return articleBody.text().replace(/\s+/g, " ").trim();
  }

  // 전체 body 텍스트 (최후의 수단)
  return $("body").text().replace(/\s+/g, " ").trim();
}

function extractMetaFromParsed($: CheerioAPI): { title?: string; date?: string; press?: string } {
  const meta: { title?: string; date?: string; press?: string } = {};

  meta.title =
    $(".media_end_head_headline, #title_area, .article_header h1, h1.headline").first().text().trim() ||
    $('meta[property="og:title"]').attr("content") ||
    $("title").text().trim();

  const dateEl = $(".media_end_head_info_datestamp_time, .article_info .date, time, .author em");
  meta.date = dateEl.attr("data-date-time") || dateEl.first().text().trim();

  meta.press =
    $(".media_end_head_top_logo img").attr("alt") ||
    $('meta[property="og:article:author"]').attr("content") ||
    $('meta[name="twitter:creator"]').attr("content") ||
    "";

  return meta;
}

export async function extractArticleDetail(
  article: SearchArticle,
  claude: Anthropic,
  model: string,
): Promise<ArticleDetail> {
  const url = article.naverLink || article.originalLink;

  let html: string;
  try {
    html = await fetchArticleHtml(url);
  } catch (error) {
    // 네이버 링크 실패 시 원본 링크 시도
    if (article.naverLink && article.originalLink) {
      try {
        html = await fetchArticleHtml(article.originalLink);
      } catch {
        return {
          title: article.title,
          publishDate: article.date,
          reporter: "알 수 없음",
          press: article.press,
          body: `[본문을 가져올 수 없습니다: ${url}]`,
          link: url,
        };
      }
    } else {
      return {
        title: article.title,
        publishDate: article.date,
        reporter: "알 수 없음",
        press: article.press,
        body: `[본문을 가져올 수 없습니다: ${url}]`,
        link: url,
      };
    }
  }

  // Issue 13: 한 번만 파싱
  const $ = parseHtml(html);
  const textContent = extractTextFromParsed($);
  const meta = extractMetaFromParsed($);

  // 텍스트가 너무 짧으면 메타데이터 기반으로 반환
  if (textContent.length < 50) {
    return {
      title: meta.title || article.title,
      publishDate: meta.date || article.date,
      reporter: "알 수 없음",
      press: meta.press || article.press,
      body: `[본문을 충분히 가져올 수 없습니다]`,
      link: url,
    };
  }

  // Issue 7: 본문 잘림 한도 30000자로 증가
  const truncatedText = textContent.slice(0, 30000);

  // Claude를 통해 기사 내용 정확히 추출 (누락 없이)
  const response = await claude.messages.create({
    model,
    // Issue 6: max_tokens 8192로 증가
    max_tokens: 8192,
    messages: [
      {
        role: "user",
        content: `다음은 뉴스 기사 웹페이지에서 추출한 텍스트입니다. 이 텍스트에서 기사 내용만 누락 없이 정확히 추출해주세요.

반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트는 포함하지 마세요.

{
  "title": "기사 제목",
  "publishDate": "발행일 (YYYY-MM-DD 형식, 없으면 빈 문자열)",
  "reporter": "기자명 (없으면 빈 문자열)",
  "press": "언론사명",
  "body": "기사 본문 전체 (광고, 관련기사, 저작권 문구 등은 제외하되, 기사 내용은 누락 없이 모두 포함)"
}

웹페이지 텍스트:
${truncatedText}`,
      },
    ],
  });

  try {
    const text = response.content[0].type === "text" ? response.content[0].text : "";
    // JSON 블록 추출 (```json ... ``` 또는 순수 JSON)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("JSON not found in response");

    const parsed = JSON.parse(jsonMatch[0]) as {
      title: string;
      publishDate: string;
      reporter: string;
      press: string;
      body: string;
    };

    return {
      title: parsed.title || meta.title || article.title,
      publishDate: parsed.publishDate || meta.date || article.date,
      reporter: parsed.reporter || "알 수 없음",
      press: parsed.press || meta.press || article.press,
      body: parsed.body || textContent,
      link: url,
    };
  } catch {
    // JSON 파싱 실패 시 메타데이터 기반으로 반환
    return {
      title: meta.title || article.title,
      publishDate: meta.date || article.date,
      reporter: "알 수 없음",
      press: meta.press || article.press,
      body: textContent.slice(0, 5000),
      link: url,
    };
  }
}

export async function extractAllArticles(
  articles: SearchArticle[],
  claude: Anthropic,
  model: string,
): Promise<ArticleDetail[]> {
  const results: ArticleDetail[] = [];
  const total = articles.length;

  console.log(`\n📄 기사 본문 추출 중... (${total}건)`);

  for (let i = 0; i < total; i++) {
    process.stdout.write(`\r   [${i + 1}/${total}] ${articles[i].title.slice(0, 40)}...`);
    try {
      const detail = await extractArticleDetail(articles[i], claude, model);
      results.push(detail);
    } catch (error) {
      console.error(`\n   ⚠️  기사 추출 실패: ${articles[i].title}`);
      results.push({
        title: articles[i].title,
        publishDate: articles[i].date,
        reporter: "알 수 없음",
        press: articles[i].press,
        body: "[추출 실패]",
        link: articles[i].naverLink || articles[i].originalLink,
      });
    }

    // API rate limit 방지
    if (i < total - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  console.log(`\n   ✅ ${results.length}건의 기사 본문 추출 완료\n`);
  return results;
}
