import axios from "axios";
import * as cheerio from "cheerio";
import type { SearchArticle } from "./types.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DELAY_MS = 500;

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
  return str.replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#039;/g, "'").trim();
}

// ============================================================
// 방법 1: 네이버 Open API (주 방법 — 안정적)
// ============================================================

interface NaverApiItem {
  title: string;
  originallink: string;
  link: string;
  description: string;
  pubDate: string;
}

interface NaverApiResponse {
  lastBuildDate: string;
  total: number;
  start: number;
  display: number;
  items: NaverApiItem[];
}

function parseNaverDate(pubDate: string): Date {
  // "Thu, 04 Mar 2026 09:30:00 +0900" 형태
  return new Date(pubDate);
}

function formatPubDate(pubDate: string): string {
  const d = parseNaverDate(pubDate);
  if (isNaN(d.getTime())) return pubDate;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}.${m}.${day}`;
}

async function searchViaNaverApi(
  keyword: string,
  days: number,
  clientId: string,
  clientSecret: string,
): Promise<SearchArticle[]> {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const allArticles: SearchArticle[] = [];
  const seenLinks = new Set<string>();
  const displaySize = 100;
  let start = 1;
  const maxStart = 1000;

  console.log(`\n🔍 네이버 뉴스 검색 (Open API): "${keyword}" (최근 ${days}일)`);
  console.log(`   기간: ${formatDate(startDate).dot} ~ ${formatDate(endDate).dot}`);

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
        const pubDate = parseNaverDate(item.pubDate);

        // 날짜 범위 밖 (너무 오래된 기사) → 검색 중단
        if (pubDate < startDate) {
          hasOldArticle = true;
          continue;
        }

        // 날짜 범위 밖 (미래 — 혹시 모를 케이스)
        if (pubDate > endDate) continue;

        const key = item.link || item.originallink;
        if (seenLinks.has(key)) continue;
        seenLinks.add(key);

        const naverLink = item.link.includes("news.naver.com") ? item.link : null;

        allArticles.push({
          title: stripHtml(item.title),
          originalLink: item.originallink,
          naverLink,
          press: "", // API는 언론사를 별도로 제공하지 않음
          date: formatPubDate(item.pubDate),
          summary: stripHtml(item.description),
        });

        newCount++;
      }

      process.stdout.write(`\r   검색 중... (${allArticles.length}건 수집, 전체 ${total}건)`);

      if (hasOldArticle || newCount === 0) break;

      start += displaySize;
      await sleep(DELAY_MS);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        console.error(`\n   ❌ 네이버 API 인증 실패. NAVER_CLIENT_ID/SECRET을 확인하세요.`);
        break;
      }
      console.error(`\n   ⚠️  API 요청 실패: ${errMsg}`);
      break;
    }
  }

  console.log(`\n   ✅ 총 ${allArticles.length}건의 기사를 찾았습니다.\n`);
  return allArticles;
}

// ============================================================
// 방법 2: 웹 스크래핑 (API 키 없을 때 폴백)
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

  // 셀렉터 우선순위: 최신 구조 → 이전 구조
  const containers = $(".list_news .bx").length > 0
    ? $(".list_news .bx")
    : $(".news_area");

  containers.each((_, el) => {
    const $el = $(el);

    const $titleLink = $el.find("a.news_tit");
    const title = $titleLink.attr("title") || $titleLink.text().trim();
    const originalLink = $titleLink.attr("href") || "";

    const press = $el.find(".info.press, a.info.press").first().text().replace("언론사 선정", "").trim();

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

  console.log(`\n🔍 네이버 뉴스 검색 (웹 스크래핑): "${keyword}" (최근 ${days}일)`);
  console.log(`   기간: ${formatDate(startDate).dot} ~ ${formatDate(endDate).dot}`);
  console.log(`   ⚠️  네이버 HTML 구조 변경으로 검색이 불안정할 수 있습니다.`);
  console.log(`   💡 안정적인 검색을 위해 .env에 NAVER_CLIENT_ID/SECRET을 설정하세요.\n`);

  while (page <= maxPages) {
    const url = buildSearchUrl(keyword, startDate, endDate, page);

    try {
      const response = await axios.get(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        timeout: 15000,
      });

      const articles = parseSearchPage(response.data);

      if (articles.length === 0) {
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

      process.stdout.write(`\r   페이지 ${page} 탐색 완료 (신규 ${newCount}건, 누적 ${allArticles.length}건)`);

      if (newCount === 0) {
        break;
      }

      page++;
      await sleep(DELAY_MS);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`\n   ⚠️  페이지 ${page} 요청 실패: ${errMsg}`);

      try {
        await sleep(1000);
        const retryResponse = await axios.get(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          timeout: 15000,
        });

        const retryArticles = parseSearchPage(retryResponse.data);
        if (retryArticles.length === 0) {
          page++;
          consecutiveErrors++;
          if (consecutiveErrors >= 3) break;
          continue;
        }

        consecutiveErrors = 0;
        let newCount = 0;
        for (const article of retryArticles) {
          const key = article.naverLink || article.originalLink;
          if (!seenLinks.has(key)) {
            seenLinks.add(key);
            allArticles.push(article);
            newCount++;
          }
        }

        process.stdout.write(`\r   페이지 ${page} 재시도 성공 (신규 ${newCount}건, 누적 ${allArticles.length}건)`);
        page++;
        await sleep(DELAY_MS);
        continue;
      } catch {
        console.error(`   재시도도 실패. 다음 페이지로 진행합니다.`);
        page++;
        consecutiveErrors++;
        if (consecutiveErrors >= 3) break;
        continue;
      }
    }
  }

  console.log(`\n   ✅ 총 ${allArticles.length}건의 기사를 찾았습니다.\n`);
  return allArticles;
}

// ============================================================
// 통합 진입점
// ============================================================

export async function scrapeNaverNews(
  keyword: string,
  days: number,
  naverClientId?: string,
  naverClientSecret?: string,
): Promise<SearchArticle[]> {
  // 네이버 API 키가 있으면 API 사용, 없으면 웹 스크래핑
  if (naverClientId && naverClientSecret) {
    return searchViaNaverApi(keyword, days, naverClientId, naverClientSecret);
  }

  console.log("\n   ℹ️  네이버 API 키가 설정되지 않아 웹 스크래핑을 시도합니다.");
  return searchViaScraping(keyword, days);
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
