import axios from "axios";
import * as cheerio from "cheerio";
import type { SearchArticle } from "./types.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DELAY_MS = 500;

function formatDate(date: Date): { dot: string; compact: string } {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return { dot: `${y}.${m}.${d}`, compact: `${y}${m}${d}` };
}

function buildSearchUrl(keyword: string, startDate: Date, endDate: Date, page: number): string {
  const ds = formatDate(startDate);
  const de = formatDate(endDate);
  const start = (page - 1) * 10 + 1;

  const params = new URLSearchParams({
    where: "news",
    query: `"${keyword}"`,
    sort: "1", // 최신순
    pd: "3", // 기간 설정
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

  $(".news_area").each((_, el) => {
    const $el = $(el);

    const $titleLink = $el.find("a.news_tit");
    const title = $titleLink.attr("title") || $titleLink.text().trim();
    const originalLink = $titleLink.attr("href") || "";

    const press = $el.find(".info.press").first().text().replace("언론사 선정", "").trim();

    // 네이버뉴스 링크 찾기
    let naverLink: string | null = null;
    $el.find("a.info").each((_, a) => {
      const href = $(a).attr("href") || "";
      if (href.includes("news.naver.com")) {
        naverLink = href;
      }
    });

    // 날짜 정보
    const dateTexts: string[] = [];
    $el.find(".info_group span.info").each((_, span) => {
      dateTexts.push($(span).text().trim());
    });
    const date = dateTexts[dateTexts.length - 1] || "";

    const summary = $el.find(".dsc_txt_wrap").text().trim();

    if (title && originalLink) {
      articles.push({ title, originalLink, naverLink, press, date, summary });
    }
  });

  return articles;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function scrapeNaverNews(keyword: string, days: number): Promise<SearchArticle[]> {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const allArticles: SearchArticle[] = [];
  const seenLinks = new Set<string>();
  let page = 1;
  const maxPages = 100;

  console.log(`\n🔍 네이버 뉴스 검색: "${keyword}" (최근 ${days}일)`);
  console.log(`   기간: ${formatDate(startDate).dot} ~ ${formatDate(endDate).dot}`);

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
      if (axios.isAxiosError(error)) {
        console.error(`\n   ⚠️  페이지 ${page} 요청 실패: ${error.message}`);
      } else {
        console.error(`\n   ⚠️  페이지 ${page} 파싱 오류:`, error);
      }
      break;
    }
  }

  console.log(`\n   ✅ 총 ${allArticles.length}건의 기사를 찾았습니다.\n`);
  return allArticles;
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
