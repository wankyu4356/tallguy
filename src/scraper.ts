import axios from "axios";
import * as cheerio from "cheerio";
import type { SearchArticle } from "./types.js";
import { logger } from "./logger.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

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
// 방법 1: 웹 스크래핑 (데스크톱 + 모바일 + JSON 추출)
// ============================================================

function buildDesktopSearchUrl(keyword: string, startDate: Date, endDate: Date, page: number): string {
  const ds = formatDate(startDate);
  const de = formatDate(endDate);
  const start = (page - 1) * 10 + 1;

  const params = new URLSearchParams({
    where: "news",
    query: keyword,
    sort: "1",
    pd: "3",
    ds: ds.dot,
    de: de.dot,
    start: String(start),
    nso: `so:dd,p:from${ds.compact}to${de.compact},a:all`,
  });

  return `https://search.naver.com/search.naver?${params.toString()}`;
}

function buildMobileSearchUrl(keyword: string, startDate: Date, endDate: Date, page: number): string {
  const ds = formatDate(startDate);
  const de = formatDate(endDate);
  const start = (page - 1) * 15 + 1;

  const params = new URLSearchParams({
    where: "m_news",
    query: keyword,
    sort: "1",
    pd: "3",
    ds: ds.dot,
    de: de.dot,
    start: String(start),
    nso: `so:dd,p:from${ds.compact}to${de.compact},a:all`,
  });

  return `https://m.search.naver.com/search.naver?${params.toString()}`;
}

/** 데스크톱 HTML에서 CSS 셀렉터로 뉴스 파싱 */
function parseDesktopPage(html: string): SearchArticle[] {
  const $ = cheerio.load(html);
  const articles: SearchArticle[] = [];

  // 여러 가지 셀렉터 시도 (네이버가 수시로 변경)
  const selectors = [
    "ul.list_news > li.bx",
    ".list_news .bx",
    ".group_news .bx",
    ".news_area",
    "li.bx .news_wrap",
    ".sp_nws .bx",
    "[class*='news'] [class*='bx']",
  ];

  for (const sel of selectors) {
    const found = $(sel);
    if (found.length > 0) {
      logger.info(`데스크톱 셀렉터 매칭: "${sel}" → ${found.length}건`);

      found.each((_, el) => {
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
    $el.find("a.info, a").each((_, a) => {
      const href = $(a).attr("href") || "";
      if (href.includes("news.naver.com") && !naverLink) {
        naverLink = href;
      }
    });

    const dateTexts: string[] = [];
    $el.find(".info_group span.info").each((_, span) => {
      dateTexts.push($(span).text().trim());
    });
    const date = dateTexts[dateTexts.length - 1] || "";

    const summary = $el.find(".dsc_txt_wrap, .news_dsc .dsc_txt_wrap, a.api_txt_lines").text().trim();

        if (title && originalLink) {
          articles.push({ title, originalLink, naverLink, press, date, summary });
        }
      });

      return articles;
    }
  }

  return articles;
}

/** HTML에서 __NEXT_DATA__ 또는 인라인 JSON 데이터 추출 */
function parseEmbeddedJson(html: string): SearchArticle[] {
  const articles: SearchArticle[] = [];

  // 1) __NEXT_DATA__ (Next.js)
  const nextDataMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const extracted = extractNewsFromJson(data);
      if (extracted.length > 0) {
        logger.info(`__NEXT_DATA__에서 ${extracted.length}건 추출`);
        return extracted;
      }
    } catch {
      logger.warn("__NEXT_DATA__ JSON 파싱 실패");
    }
  }

  // 2) window.__PRELOADED_STATE__ 또는 유사 패턴
  const preloadPatterns = [
    /window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});/,
    /window\.__SSR_DATA__\s*=\s*(\{[\s\S]*?\});/,
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/,
  ];
  for (const pattern of preloadPatterns) {
    const match = html.match(pattern);
    if (match) {
      try {
        const data = JSON.parse(match[1]);
        const extracted = extractNewsFromJson(data);
        if (extracted.length > 0) {
          logger.info(`인라인 JSON에서 ${extracted.length}건 추출`);
          return extracted;
        }
      } catch {
        // continue
      }
    }
  }

  // 3) <script> 태그 안에서 뉴스 배열 패턴 탐색
  const scriptTags = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g);
  for (const match of scriptTags) {
    const content = match[1];
    if (content.length < 100 || content.length > 500000) continue;

    // JSON 배열 패턴: "title" 또는 "originallink" 가 포함된 대괄호 블록
    if (content.includes('"title"') && (content.includes('"link"') || content.includes('"originallink"') || content.includes('"href"'))) {
      // 중괄호 배열 추출 시도
      const arrayMatches = content.matchAll(/\[(\{[\s\S]*?\})\]/g);
      for (const am of arrayMatches) {
        try {
          const arr = JSON.parse(`[${am[1]}]`);
          if (Array.isArray(arr) && arr.length > 0 && arr[0].title) {
            for (const item of arr) {
              if (item.title && (item.link || item.originallink || item.href)) {
                articles.push({
                  title: stripHtml(String(item.title)),
                  originalLink: item.originallink || item.link || item.href || "",
                  naverLink: (item.link || "").includes("news.naver.com") ? item.link : null,
                  press: item.press || item.officeName || "",
                  date: item.pubDate || item.datetime || item.date || "",
                  summary: stripHtml(String(item.description || item.body || "")),
                });
              }
            }
          }
        } catch {
          // not valid JSON array
        }
      }
    }
  }

  if (articles.length > 0) {
    logger.info(`스크립트 태그에서 ${articles.length}건 추출`);
  }

  return articles;
}

/** JSON 객체를 재귀 탐색하여 뉴스 아이템 추출 */
function extractNewsFromJson(obj: unknown, depth = 0): SearchArticle[] {
  if (depth > 10 || !obj || typeof obj !== "object") return [];

  const articles: SearchArticle[] = [];

  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (item && typeof item === "object" && "title" in item) {
        const o = item as Record<string, unknown>;
        const link = String(o.originallink || o.link || o.href || o.url || "");
        if (link) {
          articles.push({
            title: stripHtml(String(o.title || "")),
            originalLink: link,
            naverLink: link.includes("news.naver.com") ? link : null,
            press: String(o.press || o.officeName || o.source || ""),
            date: String(o.pubDate || o.datetime || o.date || ""),
            summary: stripHtml(String(o.description || o.body || o.snippet || "")),
          });
        }
      }
      // 재귀 탐색
      if (articles.length === 0) {
        articles.push(...extractNewsFromJson(item, depth + 1));
      }
    }
    return articles;
  }

  // 객체의 모든 값을 순회
  for (const value of Object.values(obj as Record<string, unknown>)) {
    const found = extractNewsFromJson(value, depth + 1);
    if (found.length > 0) return found;
  }

  return articles;
}

/** 모바일 검색 페이지 파싱 */
function parseMobilePage(html: string): SearchArticle[] {
  const $ = cheerio.load(html);
  const articles: SearchArticle[] = [];

  // 모바일 셀렉터 후보
  const selectors = [
    ".news_wrap",
    ".bx .news_area",
    "ul.list_news > li",
    ".api_subject_bx .bx",
    ".news_lst .bx",
    "div[class*='news'] li",
  ];

  for (const sel of selectors) {
    const found = $(sel);
    if (found.length > 0) {
      logger.info(`모바일 셀렉터 매칭: "${sel}" → ${found.length}건`);

      found.each((_, el) => {
        const $el = $(el);

        const $titleLink = $el.find("a.news_tit, .news_tit a, a.api_txt_lines, .tit, a[class*='tit']").first();
        const title = ($titleLink.attr("title") || $titleLink.text()).trim();
        const originalLink = $titleLink.attr("href") || "";

        const press = ($el.find(".info.press, a.info.press, .sub_txt .press, .press").first().text() || "")
          .replace("언론사 선정", "").trim();

        let naverLink: string | null = null;
        $el.find("a").each((_, a) => {
          const href = $(a).attr("href") || "";
          if (href.includes("news.naver.com") && !naverLink) {
            naverLink = href;
          }
        });

        const date = ($el.find(".sub_txt span, .info_group span.info, .sub_info span").last().text() || "").trim();
        const summary = $el.find(".dsc_txt_wrap, .api_txt_lines, .news_dsc").text().trim();

        if (title && originalLink) {
          articles.push({ title: stripHtml(title), originalLink, naverLink, press, date, summary });
        }
      });

      return articles;
    }
  }

  return articles;
}

async function searchViaScraping(keyword: string, days: number): Promise<SearchArticle[]> {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  logger.info(`[웹 스크래핑] 네이버 뉴스 검색: "${keyword}" (최근 ${days}일)`);
  logger.info(`검색 기간: ${formatDate(startDate).dot} ~ ${formatDate(endDate).dot}`);

  // ── 시도 1: 데스크톱 검색 (CSS 셀렉터) ──
  logger.info("시도 1/3: 데스크톱 검색 (CSS 셀렉터)...");
  const desktopArticles = await fetchAndParsePaged(
    (page) => buildDesktopSearchUrl(keyword, startDate, endDate, page),
    (html) => parseDesktopPage(html),
    USER_AGENT,
    "데스크톱",
  );
  if (desktopArticles.length > 0) return desktopArticles;

  // ── 시도 2: 데스크톱 HTML에서 JSON 데이터 추출 ──
  logger.info("시도 2/3: 데스크톱 HTML 내 JSON 데이터 추출...");
  try {
    const url = buildDesktopSearchUrl(keyword, startDate, endDate, 1);
    const response = await axios.get(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "ko-KR,ko;q=0.9" },
      timeout: 15000,
    });
    const jsonArticles = parseEmbeddedJson(response.data);
    if (jsonArticles.length > 0) {
      logger.info(`JSON 추출 성공: ${jsonArticles.length}건`);
      return jsonArticles;
    }
    logger.warn("HTML 내 JSON 데이터에서 뉴스를 찾지 못했습니다.");
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`JSON 추출 실패: ${errMsg}`);
  }

  // ── 시도 3: 모바일 검색 ──
  logger.info("시도 3/3: 모바일 검색 (m.search.naver.com)...");
  const mobileArticles = await fetchAndParsePaged(
    (page) => buildMobileSearchUrl(keyword, startDate, endDate, page),
    (html) => {
      // 모바일에서도 JSON 추출 시도
      const fromJson = parseEmbeddedJson(html);
      if (fromJson.length > 0) return fromJson;
      return parseMobilePage(html);
    },
    MOBILE_USER_AGENT,
    "모바일",
  );
  if (mobileArticles.length > 0) return mobileArticles;

  logger.error(
    "모든 스크래핑 방법이 실패했습니다. " +
    "네이버 검색은 JavaScript로 렌더링되어 정적 HTML 파싱이 불가능할 수 있습니다. " +
    "네이버 Open API 키를 설정하면 안정적으로 검색할 수 있습니다. " +
    "(https://developers.naver.com → 애플리케이션 등록 → 검색 API)",
  );
  return [];
}

/** 페이지네이션 포함 fetch + parse 루프 */
async function fetchAndParsePaged(
  buildUrl: (page: number) => string,
  parse: (html: string) => SearchArticle[],
  userAgent: string,
  label: string,
): Promise<SearchArticle[]> {
  const allArticles: SearchArticle[] = [];
  const seenLinks = new Set<string>();
  let page = 1;
  let consecutiveErrors = 0;
  const maxPages = 100;

  while (page <= maxPages) {
    const url = buildUrl(page);
    logger.info(`[${label}] 페이지 ${page} 요청 중...`);

    try {
      const response = await axios.get(url, {
        headers: {
          "User-Agent": userAgent,
          "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        timeout: 15000,
      });

      logger.info(`[${label}] 페이지 ${page} HTTP ${response.status} (HTML ${response.data.length}바이트)`);

      const articles = parse(response.data);
      logger.info(`[${label}] 페이지 ${page} 파싱 결과: ${articles.length}건`);

      if (articles.length === 0) {
        if (page === 1) {
          logger.warn(`[${label}] 첫 페이지에서 기사를 찾지 못했습니다.`);
        }
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

      logger.info(`[${label}] 페이지 ${page}: 신규 ${newCount}건, 누적 ${allArticles.length}건`);

      if (newCount === 0) break;

      page++;
      await sleep(DELAY_MS);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[${label}] 페이지 ${page} 요청 실패: ${errMsg}`, error);
      page++;
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        logger.warn(`[${label}] 연속 3회 실패. 중단.`);
        break;
      }
      await sleep(1000);
    }
  }

  logger.info(`[${label}] 완료: 총 ${allArticles.length}건`);
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
    logger.error(
      "네이버 API 키가 설정되지 않았습니다. " +
      "초기 설정에서 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET을 입력하세요. " +
      "(무료: https://developers.naver.com → 애플리케이션 등록 → 검색 API)",
    );
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
            query: keyword,
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

      logger.info(`[네이버 API] ${allArticles.length}건 수집 (전체 ${total}건)`);

      if (hasOldArticle || newCount === 0) break;

      start += displaySize;
      await sleep(DELAY_MS);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        logger.error("네이버 API 인증 실패 (401). NAVER_CLIENT_ID/SECRET 값을 확인하세요.");
      } else if (axios.isAxiosError(error) && error.response?.status === 429) {
        logger.error("네이버 API 호출 한도 초과 (429). 잠시 후 다시 시도하세요.");
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

  // auto: API 키가 있으면 API 우선, 없으면 스크래핑
  const hasApiKeys = !!(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET);

  if (hasApiKeys) {
    logger.info("[자동 모드] 네이버 API 키 감지 → API로 먼저 시도합니다.");
    const apiResults = await searchViaNaverApi(keyword, days);

    if (apiResults.length > 0) {
      return apiResults;
    }

    logger.warn("네이버 API 결과가 0건입니다. 웹 스크래핑으로 폴백합니다.");
    return searchViaScraping(keyword, days);
  }

  logger.warn(
    "[자동 모드] 네이버 API 키가 없습니다. 웹 스크래핑을 시도하지만 " +
    "네이버 검색은 JavaScript 렌더링을 사용하여 실패할 수 있습니다. " +
    "안정적인 검색을 위해 초기 설정에서 네이버 API 키를 입력하세요.",
  );
  return searchViaScraping(keyword, days);
}

/** 더벨(thebell) 전용 fetch — 세션 쿠키 획득 후 기사 가져오기 */
async function fetchThebellHtml(url: string): Promise<string | null> {
  try {
    // 1단계: 홈페이지에서 세션 쿠키 획득
    const homeResponse = await axios.get("https://www.thebell.co.kr/", {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: (status) => status < 500,
    });

    // Set-Cookie 헤더에서 쿠키 추출
    const setCookies = homeResponse.headers["set-cookie"];
    let cookieStr = "";
    if (setCookies) {
      cookieStr = (Array.isArray(setCookies) ? setCookies : [setCookies])
        .map((c: string) => c.split(";")[0])
        .join("; ");
    }

    logger.info(`[더벨] 세션 쿠키 획득: ${cookieStr ? "성공" : "없음"}`);

    // 2단계: 쿠키를 포함하여 기사 fetch
    const articleResponse = await axios.get(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": "https://www.thebell.co.kr/",
        "Cookie": cookieStr,
        "Cache-Control": "no-cache",
      },
      timeout: 15000,
      responseType: "text",
      maxRedirects: 5,
      validateStatus: (status) => status < 500,
    });

    if (articleResponse.status === 200 && articleResponse.data && articleResponse.data.length > 500) {
      logger.info(`[더벨] 기사 fetch 성공 (${articleResponse.data.length}바이트)`);
      return articleResponse.data;
    }

    logger.warn(`[더벨] 기사 fetch 실패: HTTP ${articleResponse.status}, 길이: ${articleResponse.data?.length || 0}`);

    // 3단계: free 기사 URL 변형 시도
    // /free/content/ → /free/Content/ 등 대소문자 변형
    const altUrls = [
      url.replace("/free/content/", "/free/Content/"),
      url.replace("www.thebell.co.kr", "m.thebell.co.kr"),
    ];

    for (const altUrl of altUrls) {
      try {
        const altResponse = await axios.get(altUrl, {
          headers: {
            "User-Agent": MOBILE_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ko-KR,ko;q=0.9",
            "Referer": "https://www.thebell.co.kr/",
            "Cookie": cookieStr,
          },
          timeout: 15000,
          responseType: "text",
          maxRedirects: 5,
          validateStatus: (status) => status < 500,
        });

        if (altResponse.status === 200 && altResponse.data && altResponse.data.length > 500) {
          logger.info(`[더벨] 대체 URL fetch 성공: ${altUrl} (${altResponse.data.length}바이트)`);
          return altResponse.data;
        }
      } catch {
        // 다음 URL 시도
      }
    }

    return null;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn(`[더벨] fetch 실패: ${errMsg}`);
    return null;
  }
}

export async function fetchArticleHtml(url: string): Promise<string> {
  // 더벨 전용 처리
  if (url.includes("thebell.co.kr")) {
    const thebellHtml = await fetchThebellHtml(url);
    if (thebellHtml) return thebellHtml;
    logger.warn(`[더벨] 전용 fetch 실패, 일반 방식으로 재시도`);
  }

  // URL에서 origin 추출하여 Referer로 사용
  let referer: string;
  try {
    const u = new URL(url);
    referer = u.origin + "/";
  } catch {
    referer = url;
  }

  const headerSets = [
    // 1차: 데스크톱 Chrome + Referer
    {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      "Referer": referer,
      "Cache-Control": "no-cache",
    },
    // 2차: 모바일 UA + Referer
    {
      "User-Agent": MOBILE_USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9",
      "Referer": referer,
    },
    // 3차: 구글봇 (일부 사이트가 허용)
    {
      "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Accept": "text/html",
      "Accept-Language": "ko-KR,ko;q=0.9",
    },
  ];

  for (let i = 0; i < headerSets.length; i++) {
    try {
      const response = await axios.get(url, {
        headers: headerSets[i],
        timeout: 15000,
        responseType: "text",
        maxRedirects: 5,
        validateStatus: (status) => status < 500,
      });

      if (response.status === 200 && response.data && response.data.length > 500) {
        return response.data;
      }

      if (response.status === 403 || response.status === 401) {
        logger.warn(`[본문 fetch] ${url} → HTTP ${response.status} (시도 ${i + 1}/${headerSets.length})`);
        continue;
      }

      if (response.data && response.data.length > 500) {
        return response.data;
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.warn(`[본문 fetch] ${url} → 오류 (시도 ${i + 1}/${headerSets.length}): ${errMsg}`);
    }
  }

  throw new Error(`모든 fetch 시도 실패: ${url}`);
}
