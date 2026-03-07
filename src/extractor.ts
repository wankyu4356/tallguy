import Anthropic from "@anthropic-ai/sdk";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { fetchArticleHtml } from "./scraper.js";
import type { ArticleDetail, SearchArticle } from "./types.js";

// Issue 13: cheerio를 한 번만 파싱하여 재사용
function parseHtml(html: string): CheerioAPI {
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer, iframe, .ad, .advertisement, #comment, .comment, .reply, .sns, .copyright, .relation_lst, .byline").remove();
  return $;
}

/** HTML → 문단 구분 유지하면서 텍스트 추출 */
function htmlToText(el: ReturnType<CheerioAPI>): string {
  const html = el.html() || "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 본문 추출용 CSS 셀렉터 (우선순위 순)
const CONTENT_SELECTORS = [
  // 네이버 뉴스
  "#dic_area", "#newsct_article", "#articeBody", "#articleBodyContents",
  // 주요 한국 뉴스 사이트
  "#article_body", "#articleBody", "#article-body", "#article-view-content-div",
  ".article_txt", ".article_text", "#article_text", ".article_content", "#article_content",
  "#newsContent", "#news_content", "#news_body_area", "#news_body",
  ".news_view", "#newsViewArea", ".news_article", "#news_article",
  ".view_con", ".view_cont", ".view_article", ".viewConts", "#viewContent",
  ".article-view", ".article_view", ".article-body", ".article_body",
  // 더벨 등 금융 전문 매체
  "#article_main", "#article_text", ".articleContents", ".article_con",
  "#articleContent", "#articleText", "#articleCont", ".article_txt",
  "#sArticle", ".sArticle", "#viewContent", "#viewCont",
  ".article-content", "#arl_view_content", "#newsBody",
  // skyedaily 등 중소 매체
  ".article_view_content", ".view_content", "#view_content",
  "#CmAdContent", "#textBody", "#newsEndContents",
  ".news_cont", ".news_text", ".news_detail",
  ".cont_view", "#cont_view", ".view_txt",
  "#news_contents", ".news_contents",
  // 국제 표준
  "[itemprop='articleBody']", "[data-component='text-block']",
  // 일반적 fallback
  "article", "main .content", ".post-content", ".entry-content",
  ".article-body", ".article_body", ".news_end", "#article-body",
];

/** 더벨(thebell) 전용 본문 추출 */
function extractThebellContent($: CheerioAPI): string | null {
  // 더벨 본문 셀렉터 (우선순위 순)
  const thebellSelectors = [
    "#article_main",
    ".viewSection",
    "#CmAdContent",
    ".articleView",
    ".article_view",
    "#articleBody",
    ".articleCont",
    "#viewContent",
  ];

  let el = $(thebellSelectors[0]).first();
  for (const sel of thebellSelectors) {
    const found = $(sel).first();
    if (found.length > 0) { el = found; break; }
  }
  if (el.length === 0) return null;

  // 더벨 본문 안의 불필요한 요소 제거
  el.find(".article_content_banner, .article_title_banner, .tip, .reference, .linkBox, .newsADBox, .linkNews, .optionIcon, .viewHead, .headBox, .userBox, .groupBox, script, style, iframe").remove();

  const text = htmlToText(el);
  if (text.length > 100) return text;

  // 페이월인 경우 og:description 사용
  const ogDesc = $('meta[property="og:description"]').attr("content") || "";
  if (ogDesc.length > 30) return ogDesc;

  return null;
}

function extractTextFromParsed($: CheerioAPI, url?: string): string {
  // 더벨 전용 처리
  if (url && url.includes("thebell.co.kr")) {
    const thebellText = extractThebellContent($);
    if (thebellText) return thebellText;
  }

  for (const sel of CONTENT_SELECTORS) {
    const el = $(sel).first();
    if (el.length > 0) {
      const text = htmlToText(el);
      if (text.length > 50) {
        return text;
      }
    }
  }

  // 전체 body 텍스트 (최후의 수단)
  return $("body").text().replace(/\s+/g, " ").trim();
}

function extractMetaFromParsed($: CheerioAPI, url?: string): { title?: string; date?: string; press?: string; reporter?: string } {
  const meta: { title?: string; date?: string; press?: string; reporter?: string } = {};

  // 더벨 전용 메타 추출
  if (url && url.includes("thebell.co.kr")) {
    meta.title =
      $(".viewHead .tit").first().contents().first().text().trim() ||
      $(".viewHead h1, .viewHead .title").first().text().trim() ||
      $('meta[property="og:title"]').attr("content") ||
      $("title").text().trim();
    meta.date =
      $(".viewHead .userBox .date").first().text().trim() ||
      $(".viewHead .date, .viewHead time").first().text().trim() ||
      $('meta[property="article:published_time"]').attr("content") || "";
    meta.press = "더벨";
    meta.reporter =
      $(".viewHead .userBox .user").first().text().trim() ||
      $(".viewHead .user, .viewHead .reporter, .viewHead .writer").first().text().trim() ||
      $('meta[name="author"]').attr("content") || "";
    return meta;
  }

  meta.title =
    $(".media_end_head_headline, #title_area, .article_header h1, h1.headline, .view_tit, .article_tit h1").first().text().trim() ||
    $('meta[property="og:title"]').attr("content") ||
    $("title").text().trim();

  const dateEl = $(".media_end_head_info_datestamp_time, .article_info .date, time, .author em, .view_date, .article_date");
  meta.date = dateEl.attr("data-date-time") || dateEl.first().text().trim();

  meta.press =
    $(".media_end_head_top_logo img").attr("alt") ||
    $('meta[property="og:article:author"]').attr("content") ||
    $('meta[name="twitter:creator"]').attr("content") ||
    $('meta[property="og:site_name"]').attr("content") ||
    "";

  return meta;
}

/** URL을 모바일↔데스크톱으로 변환 시도 */
function getAlternateUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.startsWith("m.")) {
      // 모바일 → 데스크톱
      u.hostname = u.hostname.slice(2);
      return u.toString();
    } else if (u.hostname.startsWith("www.")) {
      // www → 모바일
      u.hostname = "m." + u.hostname.slice(4);
      return u.toString();
    } else {
      // 기본 → 모바일 시도
      u.hostname = "m." + u.hostname;
      return u.toString();
    }
  } catch {
    return null;
  }
}

export async function extractArticleDetail(
  article: SearchArticle,
  claude: Anthropic,
  model: string,
): Promise<ArticleDetail> {
  const url = article.naverLink || article.originalLink;

  let html: string | null = null;
  const urlsToTry = [url];

  // 네이버 링크 실패 시 원본 링크 추가
  if (article.naverLink && article.originalLink) {
    urlsToTry.push(article.originalLink);
  }

  // 모바일↔데스크톱 대체 URL 추가
  for (const u of [...urlsToTry]) {
    const alt = getAlternateUrl(u);
    if (alt && !urlsToTry.includes(alt)) {
      urlsToTry.push(alt);
    }
  }

  for (const tryUrl of urlsToTry) {
    try {
      html = await fetchArticleHtml(tryUrl);
      if (html && html.length > 500) break;
      html = null;
    } catch {
      html = null;
    }
  }

  if (!html) {
    // 검색 결과의 요약(summary)이라도 사용
    const fallbackBody = article.summary && article.summary.length > 20
      ? article.summary
      : `[본문을 가져올 수 없습니다: ${url}]`;
    const isThebell = url.includes("thebell.co.kr") || article.originalLink.includes("thebell.co.kr");
    return {
      title: article.title,
      publishDate: article.date,
      reporter: "알 수 없음",
      press: isThebell ? "더벨" : (article.press || "알 수 없음"),
      body: fallbackBody,
      link: article.originalLink || url,
    };
  }

  // 더벨: 원본 HTML에서 메타를 먼저 추출 (parseHtml이 .byline 등을 제거하기 전)
  const rawMeta = url.includes("thebell.co.kr")
    ? extractMetaFromParsed(cheerio.load(html), url)
    : null;

  // Issue 13: 한 번만 파싱하여 재사용
  const $ = parseHtml(html);
  // 메타를 먼저 추출 (본문 추출 시 DOM 요소가 제거되므로)
  const meta = rawMeta || extractMetaFromParsed($, url);
  const textContent = extractTextFromParsed($, url);

  // og:description을 fallback으로 사용
  const ogDesc = $('meta[property="og:description"]').attr("content") || "";

  // 텍스트가 너무 짧으면 og:description이나 메타데이터 기반으로 반환
  if (textContent.length < 50) {
    if (ogDesc.length > 50) {
      // og:description이라도 사용
      return {
        title: meta.title || article.title,
        publishDate: meta.date || article.date,
        reporter: meta.reporter || "알 수 없음",
        press: meta.press || article.press,
        body: ogDesc,
        link: url,
      };
    }
    // 검색 결과 요약이라도 활용
    const summaryFallback = article.summary && article.summary.length > 20
      ? article.summary
      : `[본문을 충분히 가져올 수 없습니다]`;
    return {
      title: meta.title || article.title,
      publishDate: meta.date || article.date,
      reporter: meta.reporter || "알 수 없음",
      press: meta.press || article.press,
      body: summaryFallback,
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
  "body": "기사 본문 전체 (광고, 관련기사, 저작권 문구 등은 제외하되, 기사 내용은 누락 없이 모두 포함. 반드시 문단 구분을 \\n\\n으로 유지할 것. 의미 단위로 문단을 나눌 것.)"
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
      reporter: parsed.reporter || meta.reporter || "알 수 없음",
      press: parsed.press || meta.press || article.press,
      body: parsed.body || textContent,
      link: url,
    };
  } catch {
    // JSON 파싱 실패 시 메타데이터 기반으로 반환
    return {
      title: meta.title || article.title,
      publishDate: meta.date || article.date,
      reporter: meta.reporter || "알 수 없음",
      press: meta.press || article.press,
      body: textContent.slice(0, 5000),
      link: url,
    };
  }
}

export type ProgressCallback = (current: number, total: number, itemName: string) => void;

export async function extractAllArticles(
  articles: SearchArticle[],
  claude: Anthropic,
  model: string,
  onProgress?: ProgressCallback,
): Promise<ArticleDetail[]> {
  const results: ArticleDetail[] = [];
  const total = articles.length;

  console.log(`\n📄 기사 본문 추출 중... (${total}건)`);

  for (let i = 0; i < total; i++) {
    const title = articles[i].title;
    process.stdout.write(`\r   [${i + 1}/${total}] ${title.slice(0, 40)}...`);
    onProgress?.(i + 1, total, title);

    try {
      const detail = await extractArticleDetail(articles[i], claude, model);
      results.push(detail);
    } catch (error) {
      console.error(`\n   ⚠️  기사 추출 실패: ${title}`);
      results.push({
        title,
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
