import axios from "axios";
import * as cheerio from "cheerio";
import type { SearchArticle } from "./types.js";
import { logger } from "./logger.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DELAY_MS = 500;

export type SearchMethod = "scraping" | "api" | "auto";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDate(date: Date): { dot: string; compact: string } {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return { dot: `${y}.${m}.${d}`, compact: `${y}${m}${d}` };
}

// HTML 엔티티 및 태그 제거 (네이버 API 응답에 <b></b> 등 포함)
function stripHtml(str: string): string {
  return str
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#039;/g, "'")
    .trim();
}

// ============================================================
// 방법 1: 웹 스크래핑
// ============================================================

function buildSearchUrl(keyword: string, startDate: Date, endDate: Date, page: number): string {
  const ds = formatDate(startDate);
  const de = formatDate(endDate);
  const start = (page - 1) * 10 + 1;

  const params = new URLSearchParams({
    where: "news",
    query: `"${keyword}"`,
    sort: "1",
    pd: "3",
    ds: ds.dot,
    de: de.dot,
    start: String(start),
    nso: `so:dd,p:from${ds.compact}to${de.compact},a:all`,
  });

  return `https://search.naver.com/search.naver?${params.toString()}`;
}

function parseSearchPage(html: string): SearchArticle[] {
  const $ = cheerio.load(html);
  const articles: SearchArticle[] = [];

  // Strategy 1: Latest Naver structure
  let containers = $(".list_news .bx");

  // Strategy 2: Older structure
  if (containers.length === 0) {
    containers = $(".news_area");
  }

  // Strategy 3: Another common pattern
  if (containers.length === 0) {
    containers = $(".group_news .bx");
  }

  logger.debug(`HTML 파싱: ${containers.length}개 컨테이너 발견 (전체 HTML 길이: ${html.length})`);

  if (containers.length === 0) {
    logger.warn("뉴스 컨테이너를 찾을 수 없습니다. 네이버 HTML 구조가 변경되었을 수 있습니다.");
    logger.debug(`HTML 미리보기 (처음 2000자):\n${html.slice(0, 2000)}`);
    return [];
  }

  containers.each((_, el) => {
    const $el = $(el);

    const $titleLink =
      $el.find("a.news_tit").length > 0
        ? $el.find("a.news_tit")
        : $el.find(".news_tit a");
    const title = $titleLink.attr("title") || $titleLink.text().trim();
    const originalLink = $titleLink.attr("href") || "";

    const press = (
      $el.find(".info.press, a.info.press").first().text() ||
      $el.find(".press").first().text() ||
      ""
    )
      .replace("언론사 선정", "")
      .trim();

    let naverLink: string | null = null;
    $el.find("a.info").each((_, a) => {
      const href = $(a).attr("href") || "";
      if (href.includes("news.naver.com")) {
        naverLink = href;
      }
    });

    const dateTexts: string[] = [];
    $el.find(".info_group span.info").each((_, span) => {
      dateTexts.push($(span).text().trim());
    });
    const date = dateTexts[dateTexts.length - 1] || "";

    const summary = $el.find(".dsc_txt_wrap, .news_dsc .dsc_txt_wrap").text().trim();

    if (title && originalLink) {
      articles.push({ title, originalLink, naverLink, press, date, summary });
    }
  });

  return articles;
}

async function searchViaScraping(keyword: string, days: number): Promise<SearchArticle[]> {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const allArticles: SearchArticle[] = [];
  const seenLinks = new Set<string>();
  let page = 1;
  let consecutiveErrors = 0;
  const maxPages = 100;

  logger.info(`[웹 스크래핑] 네이버 뉴스 검색: "${keyword}" (최근 ${days}일)`);
  logger.info(`검색 기간: ${formatDate(startDate).dot} ~ ${formatDate(endDate).dot}`);

  while (page <= maxPages) {
    const url = buildSearchUrl(keyword, startDate, endDate, page);
    logger.debug(`페이지 ${page} 요청: ${url}`);

    try {
      const response = await axios.get(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        timeout: 15000,
      });

      logger.debug(`페이지 ${page} HTTP 응답 상태: ${response.status}`);

      const articles = parseSearchPage(response.data);
      logger.debug(`페이지 ${page} 파싱 결과: ${articles.length}건`);

      if (articles.length === 0) {
        logger.info(`페이지 ${page}에서 기사를 찾지 못했습니다. 검색 종료.`);
        break;
      }

      consecutiveErrors = 0;
      let newCount = 0;
      for (const article of articles) {
        const key = article.naverLink || article.originalLink;
        if (!seenLinks.has(key)) {
          seenLinks.add(key);
          allArticles.push(article);
          newCount++;
        }
      }

      logger.debug(`페이지 ${page}: 신규 ${newCount}건, 누적 ${allArticles.length}건`);

      if (newCount === 0) {
        logger.info("신규 기사가 없습니다. 검색 종료.");
        break;
      }

      page++;
      await sleep(DELAY_MS);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`페이지 ${page} 요청 실패: ${errMsg}`, error);

      page++;
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        logger.warn("연속 3회 실패. 검색 종료.");
        break;
      }
      await sleep(1000);
    }
  }

  logger.info(`[웹 스크래핑] 완료: 총 ${allArticles.length}건`);
  return allArticles;
}

// ============================================================
// 방법 2: 네이버 Open API
// ============================================================

interface NaverApiResponse {
  total: number;
  start: number;
  display: number;
  items: Array<{
    title: string;
    originallink: string;
    link: string;
    description: string;
    pubDate: string;
  }>;
}

function formatPubDate(pubDate: string): string {
  const d = new Date(pubDate);
  if (isNaN(d.getTime())) return pubDate;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}.${m}.${day}`;
}

async function searchViaNaverApi(keyword: string, days: number): Promise<SearchArticle[]> {
  const clientId = process.env.NAVER_CLIENT_ID || "";
  const clientSecret = process.env.NAVER_CLIENT_SECRET || "";

  if (!clientId || !clientSecret) {
    logger.error("네이버 API 키가 설정되지 않았습니다 (NAVER_CLIENT_ID / NAVER_CLIENT_SECRET)");
    return [];
  }

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const allArticles: SearchArticle[] = [];
  const seenLinks = new Set<string>();
  const displaySize = 100;
  let start = 1;
  const maxStart = 1000;

  logger.info(`[네이버 API] 뉴스 검색: "${keyword}" (최근 ${days}일)`);
  logger.info(`검색 기간: ${formatDate(startDate).dot} ~ ${formatDate(endDate).dot}`);

  while (start <= maxStart) {
    try {
      const response = await axios.get<NaverApiResponse>(
        "https://openapi.naver.com/v1/search/news.json",
        {
          params: {
            query: `"${keyword}"`,
            display: displaySize,
            start,
            sort: "date",
          },
          headers: {
            "X-Naver-Client-Id": clientId,
            "X-Naver-Client-Secret": clientSecret,
          },
          timeout: 15000,
        },
      );

      const { items, total } = response.data;

      if (!items || items.length === 0) break;

      let newCount = 0;
      let hasOldArticle = false;

      for (const item of items) {
        const pubDate = new Date(item.pubDate);

        if (pubDate < startDate) {
          hasOldArticle = true;
          continue;
        }
        if (pubDate > endDate) continue;

        const key = item.link || item.originallink;
        if (seenLinks.has(key)) continue;
        seenLinks.add(key);

        const naverLink = item.link.includes("news.naver.com") ? item.link : null;

        allArticles.push({
          title: stripHtml(item.title),
          originalLink: item.originallink,
          naverLink,
          press: "",
          date: formatPubDate(item.pubDate),
          summary: stripHtml(item.description),
        });

        newCount++;
      }

      logger.debug(`API 검색 중: ${allArticles.length}건 수집 (전체 ${total}건)`);

      if (hasOldArticle || newCount === 0) break;

      start += displaySize;
      await sleep(DELAY_MS);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        logger.error("네이버 API 인증 실패. NAVER_CLIENT_ID/SECRET을 확인하세요.");
      } else {
        logger.error(`네이버 API 요청 실패: ${errMsg}`, error);
      }
      break;
    }
  }

  logger.info(`[네이버 API] 완료: 총 ${allArticles.length}건`);
  return allArticles;
}

// ============================================================
// 통합 진입점 (방법 선택 + 폴백)
// ============================================================

export async function scrapeNaverNews(
  keyword: string,
  days: number,
  method: SearchMethod = "auto",
): Promise<SearchArticle[]> {
  if (method === "api") {
    return searchViaNaverApi(keyword, days);
  }

  if (method === "scraping") {
    return searchViaScraping(keyword, days);
  }

  // auto: 스크래핑 시도 → 0건이면 API 폴백
  logger.info("[자동 모드] 웹 스크래핑으로 먼저 시도합니다.");
  const scrapingResults = await searchViaScraping(keyword, days);

  if (scrapingResults.length > 0) {
    return scrapingResults;
  }

  const hasApiKeys = process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET;
  if (hasApiKeys) {
    logger.warn("웹 스크래핑 결과가 0건입니다. 네이버 API로 폴백합니다.");
    return searchViaNaverApi(keyword, days);
  }

  logger.warn("웹 스크래핑 결과가 0건이고 네이버 API 키가 없어 폴백할 수 없습니다.");
  return [];
}

export async function fetchArticleHtml(url: string): Promise<string> {
  const response = await axios.get(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "ko-KR,ko;q=0.9",
    },
    timeout: 15000,
    responseType: "text",
  });
  return response.data;
}
