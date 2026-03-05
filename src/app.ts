import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import nodemailer from "nodemailer";
import { scrapeNaverNews, type SearchMethod } from "./scraper.js";
import { extractAllArticles } from "./extractor.js";
import { rankByImportance, generateExecutiveSummary } from "./analyzer.js";
import { generateDocx } from "./docxGenerator.js";
import { logger } from "./logger.js";
import { isSetupComplete } from "./config.js";
import type {
  SearchArticle,
  RankedArticle,
  ClipperReport,
  ClipperConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

interface SessionData {
  keywords: string[];
  days: number;
  analysisPrompt: string;
  articlesByKeyword: Record<string, SearchArticle[]>;
  selectedArticles?: SearchArticle[];
  status: "searched" | "processing" | "done" | "error";
  outputPath?: string;
  sseClients: Set<express.Response>;
  logs: Array<{ level: string; message: string; timestamp: string }>;
  sendEmail?: boolean;
}

const sessions = new Map<string, SessionData>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getDateStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function ensureOutputDir(): string {
  const outputDir = path.resolve("output");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  return outputDir;
}

/** Send an SSE event to all connected clients for a session */
function broadcastSSE(
  session: SessionData,
  data: Record<string, unknown>,
): void {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of session.sseClients) {
    try {
      client.write(payload);
    } catch {
      session.sseClients.delete(client);
    }
  }
}

/** Add a log entry to the session and broadcast it */
function sessionLog(
  session: SessionData,
  level: "info" | "warn" | "error",
  message: string,
): void {
  const timestamp = new Date().toISOString();
  session.logs.push({ level, message, timestamp });
  broadcastSSE(session, { type: "log", level, message, timestamp });

  // Also log via the shared logger
  if (level === "error") {
    logger.error(message);
  } else if (level === "warn") {
    logger.warn(message);
  } else {
    logger.info(message);
  }
}

/** Send a progress event */
function sessionProgress(
  session: SessionData,
  step: number,
  totalSteps: number,
  message: string,
): void {
  // 단계별 시작점 퍼센트 계산
  const stepStartPercents = [0, 60, 80, 90, 100];
  const overallPercent = stepStartPercents[step - 1] || 0;
  broadcastSSE(session, { type: "progress", step, totalSteps, message, overallPercent });
  sessionLog(session, "info", message);
}

// ---------------------------------------------------------------------------
// Session cleanup — remove sessions older than 1 hour
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 60 * 60 * 1000;
const sessionCreatedAt = new Map<string, number>();

function cleanupSessions(): void {
  const now = Date.now();
  for (const [id, createdAt] of sessionCreatedAt) {
    if (now - createdAt > SESSION_TTL_MS) {
      const session = sessions.get(id);
      if (session) {
        // Close any lingering SSE connections
        for (const client of session.sseClients) {
          try {
            client.end();
          } catch {
            // ignore
          }
        }
      }
      sessions.delete(id);
      sessionCreatedAt.delete(id);
    }
  }
}

setInterval(cleanupSessions, 5 * 60 * 1000);

// ---------------------------------------------------------------------------
// Email settings helpers
// ---------------------------------------------------------------------------

function getEmailSettings(): {
  host: string; port: number; user: string; pass: string;
  from: string; to: string; enabled: boolean;
} {
  return {
    host: process.env.SMTP_HOST || "",
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.EMAIL_FROM || process.env.SMTP_USER || "",
    to: process.env.EMAIL_TO || "",
    enabled: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.EMAIL_TO),
  };
}

async function sendEmailWithAttachment(filePath: string, keywords: string[]): Promise<void> {
  const email = getEmailSettings();
  if (!email.enabled) {
    throw new Error("이메일 설정이 완료되지 않았습니다.");
  }

  const transporter = nodemailer.createTransport({
    host: email.host,
    port: email.port,
    secure: email.port === 465,
    auth: { user: email.user, pass: email.pass },
  });

  const filename = path.basename(filePath);
  const today = new Date();
  const dateStr = `${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()}`;

  await transporter.sendMail({
    from: email.from,
    to: email.to,
    subject: `[뉴스 클리핑] ${keywords.join(", ")} — ${dateStr}`,
    text: `뉴스 클리핑 리포트가 생성되었습니다.\n\n키워드: ${keywords.join(", ")}\n생성일: ${dateStr}\n\n첨부된 DOCX 파일을 확인해주세요.`,
    attachments: [{ filename, path: filePath }],
  });
}

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

function buildPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>네이버 뉴스 클리퍼</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
        'Noto Sans KR', 'Malgun Gothic', sans-serif;
      background: #f5f6f8;
      color: #333;
      line-height: 1.6;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px 20px;
    }

    /* Header */
    .app-header {
      text-align: center;
      margin-bottom: 32px;
    }
    .app-header h1 {
      font-size: 28px;
      color: #1a1a1a;
      margin-bottom: 4px;
    }
    .app-header h1 span.accent { color: #03c75a; }
    .app-header p { color: #888; font-size: 14px; }

    /* Sections */
    .section {
      display: none;
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
      padding: 32px;
      margin-bottom: 24px;
    }
    .section.active { display: block; }
    .section-title {
      font-size: 20px;
      font-weight: 700;
      margin-bottom: 20px;
      color: #1a1a1a;
      padding-bottom: 12px;
      border-bottom: 2px solid #f0f0f0;
    }

    .form-group textarea {
      width: 100%;
      max-width: 500px;
      padding: 10px 14px;
      border: 1px solid #ddd;
      border-radius: 8px;
      font-size: 15px;
      font-family: inherit;
      transition: border-color 0.2s;
      outline: none;
    }
    .form-group textarea:focus { border-color: #03c75a; }

    /* Keyword chips */
    .keyword-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
      min-height: 0;
    }
    .keyword-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 5px 10px;
      border-radius: 16px;
      font-size: 13px;
      font-weight: 500;
      background: #e8f5e9;
      border: 1px solid #c8e6c9;
      color: #2e7d32;
      line-height: 1.4;
    }
    .keyword-chip .kw-term {
      display: inline-flex;
      align-items: center;
      gap: 2px;
    }
    .keyword-chip .kw-include {
      background: #c8e6c9;
      color: #1b5e20;
      padding: 1px 6px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 600;
    }
    .keyword-chip .kw-exclude {
      background: #ffcdd2;
      color: #c62828;
      padding: 1px 6px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 600;
      text-decoration: line-through;
    }
    .keyword-chip .kw-remove {
      cursor: pointer;
      font-size: 14px;
      color: #999;
      margin-left: 4px;
      line-height: 1;
    }
    .keyword-chip .kw-remove:hover { color: #e53935; }

    /* Guide box */
    .guide-box {
      background: #f0f8ff;
      border: 1px solid #b3d9ff;
      border-radius: 8px;
      padding: 14px 16px;
      font-size: 13px;
      line-height: 1.7;
      color: #1a3a5c;
    }
    .guide-box .guide-title {
      font-weight: 700;
      font-size: 14px;
      margin-bottom: 8px;
      color: #0d47a1;
    }
    .guide-box code {
      background: #e3f2fd;
      padding: 1px 5px;
      border-radius: 4px;
      font-size: 12px;
      color: #0d47a1;
    }
    .guide-box .guide-example {
      margin: 4px 0;
    }
    .guide-box .guide-arrow { color: #999; margin: 0 4px; }

    /* Forms */
    .form-group { margin-bottom: 16px; }
    .form-group label {
      display: block;
      font-size: 14px;
      font-weight: 600;
      color: #555;
      margin-bottom: 6px;
    }
    .form-group input[type="text"],
    .form-group input[type="number"],
    .form-group input[type="email"],
    .form-group input[type="password"] {
      width: 100%;
      max-width: 500px;
      padding: 10px 14px;
      border: 1px solid #ddd;
      border-radius: 8px;
      font-size: 15px;
      transition: border-color 0.2s;
      outline: none;
    }
    .form-group input:focus { border-color: #03c75a; }
    .form-group .hint {
      font-size: 12px;
      color: #999;
      margin-top: 4px;
    }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 10px 24px;
      border: 1px solid #ddd;
      border-radius: 8px;
      background: #fff;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn:hover { background: #f5f5f5; border-color: #bbb; }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-primary {
      background: #03c75a;
      color: #fff;
      border-color: #03c75a;
      font-weight: 600;
      font-size: 15px;
      padding: 12px 32px;
    }
    .btn-primary:hover { background: #02b04f; }
    .btn-primary:disabled { background: #a0dbb8; border-color: #a0dbb8; }
    .btn-secondary {
      background: #f8f9fa;
      border-color: #dee2e6;
    }
    .btn-secondary:hover { background: #e9ecef; }
    .btn-sm { padding: 6px 14px; font-size: 12px; }

    /* Keyword group */
    .keyword-group {
      margin-bottom: 24px;
      border: 1px solid #e9ecef;
      border-radius: 10px;
      overflow: hidden;
    }
    .keyword-group-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      background: #f8f9fa;
      border-bottom: 1px solid #e9ecef;
      cursor: pointer;
      user-select: none;
    }
    .keyword-group-header:hover { background: #f0f1f3; }
    .keyword-group-header .kw-name {
      font-weight: 700;
      font-size: 15px;
      color: #1a1a1a;
    }
    .keyword-group-header .kw-count {
      font-size: 13px;
      color: #666;
      background: #e9ecef;
      padding: 2px 10px;
      border-radius: 12px;
    }
    .keyword-group-header .kw-actions {
      margin-left: auto;
      display: flex;
      gap: 6px;
    }
    .keyword-group-header .kw-toggle {
      font-size: 12px;
      color: #999;
      transition: transform 0.2s;
    }
    .keyword-group.collapsed .keyword-group-body { display: none; }
    .keyword-group.collapsed .kw-toggle { transform: rotate(-90deg); }

    /* Article table */
    .article-controls {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .article-controls .count {
      margin-left: auto;
      font-size: 14px;
      color: #666;
    }

    .article-table {
      width: 100%;
      border-collapse: collapse;
    }
    .article-table thead { background: #fafafa; }
    .article-table th {
      padding: 10px 14px;
      text-align: left;
      font-size: 13px;
      font-weight: 600;
      color: #666;
      border-bottom: 2px solid #eee;
      white-space: nowrap;
    }
    .article-table td {
      padding: 10px 14px;
      border-bottom: 1px solid #f0f0f0;
      font-size: 14px;
    }
    .article-table tbody tr:hover { background: #f9fefb; }
    .article-table .col-check { width: 40px; text-align: center; }
    .article-table .col-idx { width: 48px; text-align: center; color: #999; }
    .article-table .col-title a {
      color: #1a0dab;
      text-decoration: none;
      line-height: 1.5;
    }
    .article-table .col-title a:hover { text-decoration: underline; }
    .article-table .col-title a:visited { color: #681da8; }
    .article-table .col-kw { width: 130px; white-space: nowrap; }
    .article-table .col-press { width: 130px; color: #555; white-space: nowrap; }
    .article-table .col-date { width: 110px; color: #999; white-space: nowrap; }

    /* Keyword context snippet */
    .keyword-context {
      font-size: 12px;
      color: #777;
      margin-top: 4px;
      line-height: 1.5;
    }
    .keyword-context mark {
      background: #fff3cd;
      color: #856404;
      padding: 1px 3px;
      border-radius: 3px;
      font-weight: 600;
    }

    input[type="checkbox"] {
      width: 18px;
      height: 18px;
      cursor: pointer;
      accent-color: #03c75a;
    }

    /* Progress */
    .progress-info { margin-bottom: 20px; }
    .step-label {
      font-size: 16px;
      font-weight: 600;
      color: #333;
      margin-bottom: 10px;
    }
    .progress-bar-track {
      width: 100%;
      height: 24px;
      background: #eee;
      border-radius: 12px;
      overflow: hidden;
    }
    .progress-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #03c75a, #00e676);
      border-radius: 12px;
      transition: width 0.5s ease;
      width: 0%;
      position: relative;
    }
    .progress-bar-fill::after {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: linear-gradient(
        90deg,
        rgba(255,255,255,0) 0%,
        rgba(255,255,255,0.3) 50%,
        rgba(255,255,255,0) 100%
      );
      animation: shimmer 2s infinite;
    }
    @keyframes shimmer {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }

    .log-area {
      margin-top: 20px;
      background: #1e1e1e;
      color: #d4d4d4;
      font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
      font-size: 13px;
      line-height: 1.7;
      padding: 16px;
      border-radius: 8px;
      max-height: 400px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .log-area .log-info { color: #9cdcfe; }
    .log-area .log-warn { color: #dcdcaa; }
    .log-area .log-error { color: #f48771; }
    .log-area .log-time { color: #6a9955; }

    /* Complete section */
    .complete-content { text-align: center; padding: 40px 0; }
    .complete-icon {
      font-size: 64px;
      margin-bottom: 16px;
      display: block;
    }
    .complete-msg {
      font-size: 20px;
      font-weight: 700;
      color: #03c75a;
      margin-bottom: 8px;
    }
    .complete-sub {
      font-size: 14px;
      color: #888;
      margin-bottom: 28px;
    }
    .complete-actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }

    /* Error display */
    .error-box {
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 8px;
      padding: 16px;
      color: #b91c1c;
      margin-bottom: 16px;
      display: none;
    }
    .error-box.visible { display: block; }

    /* Email toggle */
    .email-toggle {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      background: #f0f7ff;
      border: 1px solid #d0e3f7;
      border-radius: 8px;
      margin-bottom: 16px;
    }
    .email-toggle label {
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .email-toggle .email-to {
      font-size: 13px;
      color: #666;
      margin-left: auto;
    }

    /* Settings groups */
    .settings-group {
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid #eee;
    }
    .settings-group-title {
      font-size: 16px;
      font-weight: 600;
      color: #333;
      margin-bottom: 12px;
    }

    /* Spinner */
    .spinner {
      display: inline-block;
      width: 18px;
      height: 18px;
      border: 3px solid #ddd;
      border-top-color: #03c75a;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      vertical-align: middle;
      margin-right: 6px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Responsive */
    @media (max-width: 600px) {
      .container { padding: 12px 10px; }
      .section { padding: 20px 16px; }
      .btn-primary { width: 100%; justify-content: center; }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="app-header">
      <h1><span class="accent">N</span> 뉴스 클리퍼</h1>
      <p>네이버 뉴스 검색, AI 분석, DOCX 리포트 생성</p>
    </div>

    <!-- Global Error -->
    <div class="error-box" id="globalError"></div>

    <!-- Section 0: Setup -->
    <div class="section" id="sectionSetup">
      <div class="section-title">초기 설정</div>
      <p style="color:#666;margin-bottom:20px;">서비스를 사용하려면 API 키를 입력하세요. 설정은 .env 파일에 저장됩니다.</p>
      <form id="setupForm">
        <div class="form-group">
          <label for="setupAnthropicKey">Anthropic API Key (필수)</label>
          <input type="text" id="setupAnthropicKey" placeholder="sk-ant-..." required
                 style="font-family:monospace;" />
        </div>
        <div class="form-group">
          <label for="setupClaudeModel">Claude 모델</label>
          <input type="text" id="setupClaudeModel" value="" placeholder="claude-opus-4-6"
                 style="font-family:monospace;" />
        </div>
        <div class="form-group">
          <label for="setupNaverId">네이버 Client ID (선택)</label>
          <input type="text" id="setupNaverId" placeholder=""
                 style="font-family:monospace;" />
        </div>
        <div class="form-group">
          <label for="setupNaverSecret">네이버 Client Secret (선택)</label>
          <input type="text" id="setupNaverSecret" placeholder=""
                 style="font-family:monospace;" />
        </div>

        <div class="settings-group">
          <div class="settings-group-title">메일 발송 설정 (선택)</div>
          <p style="color:#999;font-size:13px;margin-bottom:12px;">설정하면 리포트 생성 후 자동으로 메일 발송 가능. 한번 설정하면 계속 유지됩니다.</p>
          <div class="form-group">
            <label for="setupSmtpHost">SMTP 서버</label>
            <input type="text" id="setupSmtpHost" placeholder="smtp.gmail.com" />
            <div class="hint">Gmail: smtp.gmail.com / Naver: smtp.naver.com / Daum: smtp.daum.net</div>
          </div>
          <div class="form-group">
            <label for="setupSmtpPort">SMTP 포트</label>
            <input type="number" id="setupSmtpPort" value="587" min="1" max="65535" style="max-width:120px;" />
            <div class="hint">587 (TLS) 또는 465 (SSL)</div>
          </div>
          <div class="form-group">
            <label for="setupSmtpUser">SMTP 사용자 (이메일)</label>
            <input type="email" id="setupSmtpUser" placeholder="your@email.com" />
          </div>
          <div class="form-group">
            <label for="setupSmtpPass">SMTP 비밀번호 / 앱 비밀번호</label>
            <input type="password" id="setupSmtpPass" placeholder="" />
            <div class="hint">Gmail은 앱 비밀번호 사용 필요 (Google 계정 > 보안 > 2단계 인증 > 앱 비밀번호)</div>
          </div>
          <div class="form-group">
            <label for="setupEmailTo">수신 이메일</label>
            <input type="email" id="setupEmailTo" placeholder="recipient@email.com" />
          </div>
        </div>

        <button type="submit" class="btn btn-primary" id="setupBtn" style="margin-top:20px;">저장 및 시작</button>
      </form>
    </div>

    <!-- Section 1: Search -->
    <div class="section" id="sectionSearch">
      <div class="section-title">검색 설정</div>
      <form id="searchForm">
        <div class="form-group">
          <label>검색 키워드</label>
          <div style="display:flex;gap:12px;align-items:flex-start;">
            <div style="flex:1;max-width:500px;">
              <div style="display:flex;gap:8px;">
                <input type="text" id="keywordInput" placeholder="예: PE, 출자" autocomplete="off"
                       style="flex:1;" onkeydown="if(event.key==='Enter'){event.preventDefault();addKeyword();}" />
                <button type="button" class="btn btn-secondary" onclick="addKeyword()" style="white-space:nowrap;">+ 추가</button>
              </div>
              <div class="keyword-chips" id="keywordChips"></div>
            </div>
            <div class="guide-box" style="flex:0 0 320px;">
              <div class="guide-title">검색어 입력 가이드</div>
              <div class="guide-example"><code>PE, 출자</code> <span class="guide-arrow">&rarr;</span> PE와 출자 <b>모두 포함</b></div>
              <div class="guide-example"><code>PE, (대출)</code> <span class="guide-arrow">&rarr;</span> PE 포함, 대출 <b>제외</b></div>
              <div class="guide-example"><code>사모펀드</code> <span class="guide-arrow">&rarr;</span> 단일 키워드 검색</div>
              <div style="margin-top:6px;font-size:12px;color:#5a7a9c;">
                쉼표로 AND 조건 구분, 괄호( )로 제외어 지정<br/>
                키워드를 여러 개 추가하면 각각 독립 검색합니다
              </div>
            </div>
          </div>
        </div>
        <div class="form-group">
          <label for="analysisPrompt">분석 기준</label>
          <textarea id="analysisPrompt" name="analysisPrompt" rows="3"
                    placeholder="예: M&A 관점에서 중요도를 분석해줘 / 반도체 산업 투자 기회 관점으로 정리해줘 / ESG 리스크 중심으로 평가해줘"
                    style="resize:vertical;min-height:60px;"></textarea>
          <div class="hint">AI가 기사를 분석·정렬할 기준을 자유롭게 입력하세요. 비워두면 일반 뉴스 중요도 순으로 정리합니다.</div>
        </div>
        <div class="form-group">
          <label for="days">검색 기간 (일)</label>
          <input type="number" id="days" name="days" value="7" min="1" max="365" oninput="updateDateRange()" />
          <div class="hint" id="dateRangeHint"></div>
        </div>
        <div class="form-group">
          <label>검색 방법</label>
          <div style="display:flex;gap:16px;margin-top:4px;">
            <label style="display:flex;align-items:center;gap:6px;font-weight:400;cursor:pointer;">
              <input type="radio" name="method" value="auto" checked style="accent-color:#03c75a;" /> 자동 (API 우선)
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-weight:400;cursor:pointer;">
              <input type="radio" name="method" value="api" style="accent-color:#03c75a;" /> 네이버 API
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-weight:400;cursor:pointer;">
              <input type="radio" name="method" value="scraping" style="accent-color:#03c75a;" /> 웹 스크래핑
            </label>
          </div>
        </div>
        <div id="emailToggleArea"></div>
        <button type="submit" class="btn btn-primary" id="searchBtn">검색 시작</button>
      </form>
      <div class="log-area" id="searchLogArea" style="display:none;margin-top:20px;"></div>
    </div>

    <!-- Section 2: Results -->
    <div class="section" id="sectionResults">
      <div class="section-title">검색 결과</div>
      <div class="article-controls">
        <button type="button" class="btn btn-secondary btn-sm" onclick="selectAllGroups()">전체 선택</button>
        <button type="button" class="btn btn-secondary btn-sm" onclick="deselectAllGroups()">전체 해제</button>
        <span class="count" id="totalArticleCount"></span>
      </div>
      <div id="articleGroupsContainer"></div>
      <div style="margin-top: 20px; text-align: right;">
        <button type="button" class="btn btn-primary" id="processBtn"
                onclick="startProcessing()">선택 완료 및 분석 시작</button>
      </div>
    </div>

    <!-- Section 3: Processing -->
    <div class="section" id="sectionProgress">
      <div class="section-title">분석 진행 중</div>
      <div class="progress-info">
        <!-- 전체 진행률 -->
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
          <div class="step-label" id="stepLabel" style="margin-bottom:0;flex:1;"><span class="spinner"></span>준비 중...</div>
          <div id="progressPercent" style="font-size:24px;font-weight:700;color:#03c75a;min-width:60px;text-align:right;">0%</div>
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" id="progressBar"></div>
        </div>
        <!-- 세부 진행 상황 -->
        <div id="detailProgress" style="margin-top:14px;padding:14px 16px;background:#f8f9fa;border-radius:8px;display:none;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <span id="detailStepName" style="font-size:14px;font-weight:600;color:#333;"></span>
            <span id="detailCount" style="font-size:13px;color:#666;"></span>
          </div>
          <div style="width:100%;height:8px;background:#e9ecef;border-radius:4px;overflow:hidden;margin-bottom:10px;">
            <div id="detailBar" style="height:100%;background:#6cb4ee;border-radius:4px;transition:width 0.3s;width:0%;"></div>
          </div>
          <div id="detailItem" style="font-size:13px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
          <div id="detailEta" style="font-size:12px;color:#aaa;margin-top:4px;"></div>
        </div>
      </div>
      <div class="log-area" id="logArea"></div>
    </div>

    <!-- Section 4: Complete -->
    <div class="section" id="sectionComplete">
      <div class="complete-content">
        <span class="complete-icon">&#x2705;</span>
        <div class="complete-msg">리포트 생성이 완료되었습니다!</div>
        <div class="complete-sub" id="completeDetail"></div>
        <div class="complete-actions">
          <a class="btn btn-primary" id="downloadBtn" href="#">DOCX 다운로드</a>
          <button type="button" class="btn btn-secondary" onclick="resetApp()">새로운 검색</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------
    var currentSessionId = null;
    var currentArticlesByKeyword = {};
    var currentKeywords = [];
    var eventSource = null;
    var emailEnabled = false;
    var emailConfigured = false;
    var emailTo = '';

    // 키워드 목록: [{raw, includes:[], excludes:[]}]
    var keywordEntries = [];

    function parseKeywordInput(raw) {
      // "PE, 출자, (대출)" → includes: ["PE","출자"], excludes: ["대출"]
      var parts = raw.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
      var includes = [];
      var excludes = [];
      parts.forEach(function(p) {
        var m = p.match(/^\((.+)\)$/);
        if (m) {
          excludes.push(m[1].trim());
        } else {
          includes.push(p);
        }
      });
      return { raw: raw.trim(), includes: includes, excludes: excludes };
    }

    function addKeyword() {
      var input = document.getElementById('keywordInput');
      var raw = input.value.trim();
      if (!raw) return;
      var parsed = parseKeywordInput(raw);
      if (parsed.includes.length === 0 && parsed.excludes.length === 0) return;
      keywordEntries.push(parsed);
      input.value = '';
      input.focus();
      renderKeywordChips();
    }

    function removeKeyword(idx) {
      keywordEntries.splice(idx, 1);
      renderKeywordChips();
    }

    function renderKeywordChips() {
      var container = document.getElementById('keywordChips');
      container.innerHTML = '';
      keywordEntries.forEach(function(entry, idx) {
        var chip = document.createElement('span');
        chip.className = 'keyword-chip';
        var termsHtml = '';
        entry.includes.forEach(function(t) {
          termsHtml += '<span class="kw-include">' + escapeHtml(t) + '</span> ';
        });
        entry.excludes.forEach(function(t) {
          termsHtml += '<span class="kw-exclude">' + escapeHtml(t) + '</span> ';
        });
        chip.innerHTML = '<span class="kw-term">' + termsHtml + '</span>' +
          '<span class="kw-remove" onclick="removeKeyword(' + idx + ')">&times;</span>';
        container.appendChild(chip);
      });
    }

    // -----------------------------------------------------------------------
    // Utility
    // -----------------------------------------------------------------------
    function escapeHtml(str) {
      var div = document.createElement('div');
      div.appendChild(document.createTextNode(str));
      return div.innerHTML;
    }

    function showSection(id) {
      document.querySelectorAll('.section').forEach(function(s) { s.classList.remove('active'); });
      document.getElementById(id).classList.add('active');
    }

    function showError(msg) {
      var el = document.getElementById('globalError');
      el.textContent = msg;
      el.classList.add('visible');
      setTimeout(function() { el.classList.remove('visible'); }, 8000);
    }

    /** 키워드 전후 문맥 추출 (하이라이트 포함) */
    function getKeywordContext(text, keyword) {
      if (!text || !keyword) return '';
      var lower = text.toLowerCase();
      var kwLower = keyword.toLowerCase();
      var idx = lower.indexOf(kwLower);
      if (idx === -1) return '';

      var contextRadius = 30;
      var start = Math.max(0, idx - contextRadius);
      var end = Math.min(text.length, idx + keyword.length + contextRadius);
      var before = (start > 0 ? '...' : '') + escapeHtml(text.substring(start, idx));
      var match = '<mark>' + escapeHtml(text.substring(idx, idx + keyword.length)) + '</mark>';
      var after = escapeHtml(text.substring(idx + keyword.length, end)) + (end < text.length ? '...' : '');
      return before + match + after;
    }

    function updateDateRange() {
      var days = parseInt(document.getElementById('days').value, 10);
      var hint = document.getElementById('dateRangeHint');
      if (isNaN(days) || days < 1) { hint.textContent = ''; return; }
      var end = new Date();
      var start = new Date();
      start.setDate(start.getDate() - days);
      var fmt = function(d) {
        return d.getFullYear() + '.' + String(d.getMonth()+1).padStart(2,'0') + '.' + String(d.getDate()).padStart(2,'0')
          + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
      };
      hint.textContent = fmt(start) + ' ~ ' + fmt(end) + ' (' + days + '일간)';
    }
    // 페이지 로드 시 초기 표시
    updateDateRange();

    function updateTotalCount() {
      var checked = document.querySelectorAll('.article-cb:checked').length;
      var total = document.querySelectorAll('.article-cb').length;
      document.getElementById('totalArticleCount').textContent = '선택: ' + checked + ' / ' + total + '건';
    }

    // -----------------------------------------------------------------------
    // Email toggle
    // -----------------------------------------------------------------------
    function renderEmailToggle() {
      var area = document.getElementById('emailToggleArea');
      if (!emailConfigured) {
        area.innerHTML = '';
        return;
      }
      var checked = emailEnabled ? 'checked' : '';
      area.innerHTML =
        '<div class="email-toggle">' +
        '  <label><input type="checkbox" id="emailCheck" ' + checked + ' onchange="emailEnabled=this.checked;localStorage.setItem(\\'emailEnabled\\',this.checked)" style="width:18px;height:18px;accent-color:#03c75a;" /> 완료 시 메일로 발송</label>' +
        '  <span class="email-to">' + escapeHtml(emailTo) + '</span>' +
        '</div>';
    }

    // -----------------------------------------------------------------------
    // Section 1: Search
    // -----------------------------------------------------------------------
    function renderSearchLogs(logs) {
      var area = document.getElementById('searchLogArea');
      area.innerHTML = '';
      if (!logs || logs.length === 0) { area.style.display = 'none'; return; }
      area.style.display = 'block';

      logs.forEach(function(log) {
        var levelClass = 'log-info';
        if (log.level === 'warn') levelClass = 'log-warn';
        if (log.level === 'error') levelClass = 'log-error';

        var time = '';
        try { time = new Date(log.timestamp).toLocaleTimeString('ko-KR'); } catch(e) {}

        var line = document.createElement('div');
        var text = escapeHtml(log.message);
        if (log.details) { text += '\\n  -> ' + escapeHtml(log.details.substring(0, 300)); }
        line.innerHTML =
          '<span class="log-time">[' + escapeHtml(time) + ']</span> ' +
          '<span class="' + levelClass + '">' + text + '</span>';
        area.appendChild(line);
      });
      area.scrollTop = area.scrollHeight;
    }

    document.getElementById('searchForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      // 아직 입력 중인 키워드가 있으면 자동 추가
      var pendingInput = document.getElementById('keywordInput').value.trim();
      if (pendingInput) { addKeyword(); }
      if (keywordEntries.length === 0) { showError('키워드를 추가해주세요.'); return; }

      var days = parseInt(document.getElementById('days').value, 10);
      var methodEl = document.querySelector('input[name="method"]:checked');
      var method = methodEl ? methodEl.value : 'auto';
      var analysisPrompt = (document.getElementById('analysisPrompt').value || '').trim();
      if (isNaN(days) || days < 1) { days = 7; }

      var btn = document.getElementById('searchBtn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>검색 중...';
      document.getElementById('searchLogArea').style.display = 'none';

      var sendEmail = emailEnabled && emailConfigured;

      try {
        var res = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keywordEntries: keywordEntries, days: days, method: method, sendEmail: sendEmail, analysisPrompt: analysisPrompt })
        });
        var data = await res.json();

        if (!res.ok) {
          renderSearchLogs(data.logs);
          throw new Error(data.error || '검색 실패');
        }

        currentSessionId = data.sessionId;
        currentArticlesByKeyword = data.articlesByKeyword;
        currentKeywords = data.keywords;

        if (data.totalCount === 0) {
          showError('검색 결과가 없습니다. 키워드나 기간을 변경해보세요.');
          renderSearchLogs(data.logs);
          btn.disabled = false;
          btn.textContent = '검색 시작';
          return;
        }

        renderSearchLogs(null);
        renderArticleGroups(data.articlesByKeyword, data.keywords);
        showSection('sectionResults');
      } catch (err) {
        showError(err.message || '검색 중 오류가 발생했습니다.');
      } finally {
        btn.disabled = false;
        btn.textContent = '검색 시작';
      }
    });

    // -----------------------------------------------------------------------
    // Section 2: Article Selection (키워드별 그룹)
    // -----------------------------------------------------------------------
    function renderArticleGroups(articlesByKeyword, keywords) {
      var container = document.getElementById('articleGroupsContainer');
      container.innerHTML = '';

      keywords.forEach(function(kw) {
        var articles = articlesByKeyword[kw] || [];
        if (articles.length === 0) return;

        var group = document.createElement('div');
        group.className = 'keyword-group';
        group.dataset.keyword = kw;

        // 키워드 파싱하여 색상 태그 생성
        var parsed = parseKeywordInput(kw);
        var kwTagsHtml = '';
        parsed.includes.forEach(function(t) {
          kwTagsHtml += '<span class="kw-include">' + escapeHtml(t) + '</span> ';
        });
        parsed.excludes.forEach(function(t) {
          kwTagsHtml += '<span class="kw-exclude">' + escapeHtml(t) + '</span> ';
        });

        // Header
        var header = document.createElement('div');
        header.className = 'keyword-group-header';
        header.innerHTML =
          '<span class="kw-toggle">&#x25BC;</span>' +
          '<span class="kw-name" style="display:inline-flex;gap:4px;align-items:center;">' + kwTagsHtml + '</span>' +
          '<span class="kw-count">' + articles.length + '건</span>' +
          '<span class="kw-actions">' +
          '  <button type="button" class="btn btn-sm btn-secondary" onclick="event.stopPropagation();selectGroup(\\'' + escapeHtml(kw).replace(/'/g, "\\\\'") + '\\')">선택</button>' +
          '  <button type="button" class="btn btn-sm btn-secondary" onclick="event.stopPropagation();deselectGroup(\\'' + escapeHtml(kw).replace(/'/g, "\\\\'") + '\\')">해제</button>' +
          '</span>';
        header.onclick = function() { group.classList.toggle('collapsed'); };

        // Body (table)
        var body = document.createElement('div');
        body.className = 'keyword-group-body';

        var table = document.createElement('table');
        table.className = 'article-table';
        table.innerHTML =
          '<thead><tr>' +
          '<th class="col-check"><input type="checkbox" checked onchange="toggleGroup(this, \\'' + escapeHtml(kw).replace(/'/g, "\\\\'") + '\\')" /></th>' +
          '<th class="col-idx">#</th>' +
          '<th class="col-kw">키워드</th>' +
          '<th>기사 제목</th>' +
          '<th class="col-press">언론사</th>' +
          '<th class="col-date">날짜</th>' +
          '</tr></thead>';

        var tbody = document.createElement('tbody');
        articles.forEach(function(a, i) {
          var tr = document.createElement('tr');
          var link = a.naverLink || a.originalLink;

          // 키워드별 문맥: 포함 키워드 각각에 대해 context 추출
          var contextHtml = '';
          parsed.includes.forEach(function(inc) {
            var ctx = getKeywordContext(a.title, inc);
            if (!ctx) ctx = getKeywordContext(a.summary, inc);
            if (ctx) {
              contextHtml += '<div class="keyword-context">' + ctx + '</div>';
            }
          });

          // 키워드 컬럼용 태그
          var cellKwHtml = '';
          parsed.includes.forEach(function(t) {
            cellKwHtml += '<span class="kw-include" style="font-size:11px;">' + escapeHtml(t) + '</span> ';
          });
          parsed.excludes.forEach(function(t) {
            cellKwHtml += '<span class="kw-exclude" style="font-size:11px;">' + escapeHtml(t) + '</span> ';
          });

          tr.innerHTML =
            '<td class="col-check"><input type="checkbox" class="article-cb" data-keyword="' + escapeHtml(kw) + '" data-index="' + i + '" checked onchange="updateTotalCount()" /></td>' +
            '<td class="col-idx">' + (i + 1) + '</td>' +
            '<td class="col-kw">' + cellKwHtml + '</td>' +
            '<td class="col-title"><a href="' + escapeHtml(link) + '" target="_blank" rel="noopener">' + escapeHtml(a.title) + '</a>' + contextHtml + '</td>' +
            '<td class="col-press">' + escapeHtml(a.press) + '</td>' +
            '<td class="col-date">' + escapeHtml(a.date) + '</td>';

          tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        body.appendChild(table);
        group.appendChild(header);
        group.appendChild(body);
        container.appendChild(group);
      });

      updateTotalCount();
    }

    function selectGroup(kw) {
      document.querySelectorAll('.article-cb[data-keyword="' + kw + '"]').forEach(function(cb) { cb.checked = true; });
      updateTotalCount();
    }

    function deselectGroup(kw) {
      document.querySelectorAll('.article-cb[data-keyword="' + kw + '"]').forEach(function(cb) { cb.checked = false; });
      updateTotalCount();
    }

    function toggleGroup(headerCb, kw) {
      document.querySelectorAll('.article-cb[data-keyword="' + kw + '"]').forEach(function(cb) { cb.checked = headerCb.checked; });
      updateTotalCount();
    }

    function selectAllGroups() {
      document.querySelectorAll('.article-cb').forEach(function(cb) { cb.checked = true; });
      document.querySelectorAll('.keyword-group-header input[type="checkbox"]').forEach(function(cb) { cb.checked = true; });
      updateTotalCount();
    }

    function deselectAllGroups() {
      document.querySelectorAll('.article-cb').forEach(function(cb) { cb.checked = false; });
      document.querySelectorAll('.keyword-group-header input[type="checkbox"]').forEach(function(cb) { cb.checked = false; });
      updateTotalCount();
    }

    async function startProcessing() {
      // 키워드별 선택된 인덱스 수집
      var selectedByKeyword = {};
      document.querySelectorAll('.article-cb:checked').forEach(function(cb) {
        var kw = cb.dataset.keyword;
        var idx = parseInt(cb.dataset.index, 10);
        if (!selectedByKeyword[kw]) selectedByKeyword[kw] = [];
        selectedByKeyword[kw].push(idx);
      });

      var totalSelected = Object.values(selectedByKeyword).reduce(function(sum, arr) { return sum + arr.length; }, 0);
      if (totalSelected === 0) {
        showError('최소 1개 이상의 기사를 선택해주세요.');
        return;
      }

      var btn = document.getElementById('processBtn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>시작하는 중...';

      try {
        var res = await fetch('/api/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: currentSessionId, selectedByKeyword: selectedByKeyword })
        });
        var data = await res.json();
        if (!res.ok) { throw new Error(data.error || '처리 시작 실패'); }

        showSection('sectionProgress');
        document.getElementById('logArea').innerHTML = '';
        document.getElementById('stepLabel').innerHTML = '<span class="spinner"></span>준비 중...';
        document.getElementById('progressBar').style.width = '0%';
        connectSSE(currentSessionId);
      } catch (err) {
        showError(err.message || '처리 시작 중 오류가 발생했습니다.');
        btn.disabled = false;
        btn.textContent = '선택 완료 및 분석 시작';
      }
    }

    // -----------------------------------------------------------------------
    // Section 3: SSE Progress
    // -----------------------------------------------------------------------
    function connectSSE(sessionId) {
      if (eventSource) { eventSource.close(); }

      eventSource = new EventSource('/api/progress/' + sessionId);

      var detailStartTime = null;

      eventSource.onmessage = function(e) {
        var data;
        try { data = JSON.parse(e.data); } catch { return; }

        if (data.type === 'progress') {
          var pct = Math.round(data.overallPercent || (data.step / data.totalSteps) * 100);
          document.getElementById('progressBar').style.width = pct + '%';
          document.getElementById('progressPercent').textContent = pct + '%';
          document.getElementById('stepLabel').innerHTML =
            '<span class="spinner"></span>' + escapeHtml('단계 ' + data.step + '/' + data.totalSteps + ': ' + data.message);
          // 세부 진행 초기화
          document.getElementById('detailProgress').style.display = 'none';
          detailStartTime = null;
        }

        if (data.type === 'detail_progress') {
          // 전체 진행률 업데이트
          var overallPct = Math.round(data.overallPercent || 0);
          document.getElementById('progressBar').style.width = overallPct + '%';
          document.getElementById('progressPercent').textContent = overallPct + '%';

          // 세부 진행 패널 표시
          var dp = document.getElementById('detailProgress');
          dp.style.display = 'block';
          document.getElementById('detailStepName').textContent = data.stepName || '';
          document.getElementById('detailCount').textContent = data.current + ' / ' + data.stepTotal;
          var subPct = Math.round((data.current / data.stepTotal) * 100);
          document.getElementById('detailBar').style.width = subPct + '%';
          document.getElementById('detailItem').textContent = data.itemName || '';

          // ETA 계산
          if (!detailStartTime) detailStartTime = Date.now();
          if (data.current > 1) {
            var elapsed = (Date.now() - detailStartTime) / 1000;
            var perItem = elapsed / (data.current - 1);
            var remaining = perItem * (data.stepTotal - data.current);
            var etaText = '';
            if (remaining > 60) {
              etaText = '약 ' + Math.ceil(remaining / 60) + '분 남음';
            } else if (remaining > 5) {
              etaText = '약 ' + Math.round(remaining) + '초 남음';
            } else {
              etaText = '거의 완료...';
            }
            document.getElementById('detailEta').textContent = etaText;
          }
        }

        if (data.type === 'log') {
          appendLog(data.level, data.message, data.timestamp);
        }

        if (data.type === 'done') {
          if (eventSource) { eventSource.close(); eventSource = null; }
          document.getElementById('progressBar').style.width = '100%';
          document.getElementById('progressPercent').textContent = '100%';
          document.getElementById('stepLabel').textContent = '완료!';
          document.getElementById('detailProgress').style.display = 'none';
          showComplete(data.filename, data.emailSent);
        }

        if (data.type === 'error') {
          if (eventSource) { eventSource.close(); eventSource = null; }
          appendLog('error', data.message, new Date().toISOString());
          document.getElementById('stepLabel').textContent = '오류 발생';
          document.getElementById('progressBar').style.width = '0%';
          document.getElementById('progressPercent').textContent = '';
          document.getElementById('detailProgress').style.display = 'none';
          showError(data.message);
        }
      };

      eventSource.onerror = function() {
        // SSE connection lost — do not close immediately; browser will retry
      };
    }

    function appendLog(level, message, timestamp) {
      var area = document.getElementById('logArea');
      var time = '';
      if (timestamp) {
        try {
          var d = new Date(timestamp);
          time = d.toLocaleTimeString('ko-KR');
        } catch { time = ''; }
      }

      var levelClass = 'log-info';
      if (level === 'warn') levelClass = 'log-warn';
      if (level === 'error') levelClass = 'log-error';

      var line = document.createElement('div');
      line.innerHTML =
        '<span class="log-time">[' + escapeHtml(time) + ']</span> ' +
        '<span class="' + levelClass + '">' + escapeHtml(message) + '</span>';
      area.appendChild(line);
      area.scrollTop = area.scrollHeight;
    }

    // -----------------------------------------------------------------------
    // Section 4: Complete
    // -----------------------------------------------------------------------
    function showComplete(filename, emailSent) {
      var detail = filename;
      if (emailSent) detail += ' (메일 발송 완료)';
      document.getElementById('completeDetail').textContent = detail;
      document.getElementById('downloadBtn').href = '/api/download/' + encodeURIComponent(filename);
      showSection('sectionComplete');
    }

    function resetApp() {
      currentSessionId = null;
      currentArticlesByKeyword = {};
      currentKeywords = [];
      if (eventSource) { eventSource.close(); eventSource = null; }
      keywordEntries = [];
      renderKeywordChips();
      document.getElementById('keywordInput').value = '';
      document.getElementById('days').value = '7';
      document.getElementById('globalError').classList.remove('visible');
      document.getElementById('processBtn').disabled = false;
      document.getElementById('processBtn').textContent = '선택 완료 및 분석 시작';
      showSection('sectionSearch');
    }

    // -----------------------------------------------------------------------
    // Section 0: Setup
    // -----------------------------------------------------------------------
    document.getElementById('setupForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      var btn = document.getElementById('setupBtn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>저장 중...';

      var settings = {
        ANTHROPIC_API_KEY: document.getElementById('setupAnthropicKey').value.trim(),
        CLAUDE_MODEL: document.getElementById('setupClaudeModel').value.trim(),
        NAVER_CLIENT_ID: document.getElementById('setupNaverId').value.trim(),
        NAVER_CLIENT_SECRET: document.getElementById('setupNaverSecret').value.trim(),
        SMTP_HOST: document.getElementById('setupSmtpHost').value.trim(),
        SMTP_PORT: document.getElementById('setupSmtpPort').value.trim(),
        SMTP_USER: document.getElementById('setupSmtpUser').value.trim(),
        SMTP_PASS: document.getElementById('setupSmtpPass').value.trim(),
        EMAIL_TO: document.getElementById('setupEmailTo').value.trim(),
      };

      if (!settings.ANTHROPIC_API_KEY) {
        showError('Anthropic API Key를 입력하세요.');
        btn.disabled = false;
        btn.textContent = '저장 및 시작';
        return;
      }

      try {
        var res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings)
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || '저장 실패');

        // 이메일 설정 상태 갱신
        emailConfigured = !!(settings.SMTP_HOST && settings.SMTP_USER && settings.SMTP_PASS && settings.EMAIL_TO);
        emailTo = settings.EMAIL_TO;
        if (emailConfigured) emailEnabled = true;
        localStorage.setItem('emailEnabled', String(emailEnabled));
        renderEmailToggle();

        showSection('sectionSearch');
      } catch (err) {
        showError(err.message);
        btn.disabled = false;
        btn.textContent = '저장 및 시작';
      }
    });

    // Auto-detect: show setup or search on page load
    (async function() {
      try {
        var res = await fetch('/api/settings');
        var data = await res.json();

        // 이메일 설정 상태
        emailConfigured = data.emailConfigured || false;
        emailTo = (data.current && data.current.EMAIL_TO) || '';
        var stored = localStorage.getItem('emailEnabled');
        emailEnabled = stored !== null ? stored === 'true' : emailConfigured;
        renderEmailToggle();

        if (data.needsSetup) {
          // Pre-fill existing values
          if (data.current.CLAUDE_MODEL) document.getElementById('setupClaudeModel').value = data.current.CLAUDE_MODEL;
          if (data.current.NAVER_CLIENT_ID) document.getElementById('setupNaverId').value = data.current.NAVER_CLIENT_ID;
          if (data.current.NAVER_CLIENT_SECRET) document.getElementById('setupNaverSecret').value = data.current.NAVER_CLIENT_SECRET;
          if (data.current.SMTP_HOST) document.getElementById('setupSmtpHost').value = data.current.SMTP_HOST;
          if (data.current.SMTP_PORT) document.getElementById('setupSmtpPort').value = data.current.SMTP_PORT;
          if (data.current.SMTP_USER) document.getElementById('setupSmtpUser').value = data.current.SMTP_USER;
          if (data.current.EMAIL_TO) document.getElementById('setupEmailTo').value = data.current.EMAIL_TO;
          showSection('sectionSetup');
        } else {
          showSection('sectionSearch');
        }
      } catch (e) {
        showSection('sectionSearch');
      }
    })();
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// createApp
// ---------------------------------------------------------------------------

export function createApp(claudeModel: string): { app: express.Express } {
  const app = express();

  // Lazy init — API 키가 설정 후에야 사용 가능
  let claude: Anthropic | null = null;
  function getClaude(): Anthropic {
    if (!claude || !process.env.ANTHROPIC_API_KEY) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error("ANTHROPIC_API_KEY가 설정되지 않았습니다. 초기 설정을 완료하세요.");
      }
      claude = new Anthropic();
    }
    return claude;
  }

  app.use(express.json({ limit: "5mb" }));

  // -------------------------------------------------------------------------
  // GET / — serve the SPA
  // -------------------------------------------------------------------------
  app.get("/", (_req, res) => {
    res.type("html").send(buildPageHtml());
  });

  // -------------------------------------------------------------------------
  // GET /api/settings — 현재 설정 상태 확인
  // -------------------------------------------------------------------------
  app.get("/api/settings", (_req, res) => {
    const email = getEmailSettings();
    res.json({
      needsSetup: !isSetupComplete(),
      emailConfigured: email.enabled,
      current: {
        CLAUDE_MODEL: process.env.CLAUDE_MODEL || "",
        NAVER_CLIENT_ID: process.env.NAVER_CLIENT_ID || "",
        NAVER_CLIENT_SECRET: process.env.NAVER_CLIENT_SECRET || "",
        SMTP_HOST: process.env.SMTP_HOST || "",
        SMTP_PORT: process.env.SMTP_PORT || "587",
        SMTP_USER: process.env.SMTP_USER || "",
        EMAIL_TO: process.env.EMAIL_TO || "",
      },
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/settings — .env 저장 및 환경변수 반영
  // -------------------------------------------------------------------------
  app.post("/api/settings", (req, res) => {
    try {
      const body = req.body as Record<string, string>;
      const envPath = path.resolve(".env");

      const envKeys = [
        "ANTHROPIC_API_KEY", "CLAUDE_MODEL",
        "NAVER_CLIENT_ID", "NAVER_CLIENT_SECRET",
        "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS",
        "EMAIL_FROM", "EMAIL_TO",
      ];

      const lines: string[] = [];
      for (const key of envKeys) {
        const val = body[key] || process.env[key] || "";
        if (val) lines.push(`${key}=${val}`);
      }

      fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");

      // 환경변수 즉시 반영
      for (const key of envKeys) {
        if (body[key]) process.env[key] = body[key];
      }

      logger.info("설정이 저장되었습니다.");
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "설정 저장 실패";
      logger.error("설정 저장 오류: " + msg, err);
      res.status(500).json({ error: msg });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/search — 복수 키워드 검색
  // -------------------------------------------------------------------------
  app.post("/api/search", async (req, res) => {
    // 검색 중 발생하는 로그를 캡처
    const searchLogs: Array<{ level: string; message: string; timestamp: string; details?: string }> = [];
    const unsubscribe = logger.subscribe((entry) => {
      searchLogs.push({
        level: entry.level,
        message: entry.message,
        timestamp: entry.timestamp,
        ...(entry.details && { details: entry.details }),
      });
    });

    try {
      const { keywordEntries: rawEntries, days, method, sendEmail, analysisPrompt: rawPrompt } = req.body as {
        keywordEntries: unknown;
        days: unknown;
        method: unknown;
        sendEmail: unknown;
        analysisPrompt: unknown;
      };

      // keywordEntries 파싱: [{raw, includes:[], excludes:[]}]
      if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
        unsubscribe();
        res.status(400).json({ error: "키워드를 추가해주세요." });
        return;
      }

      interface KeywordEntry {
        raw: string;
        includes: string[];
        excludes: string[];
      }

      const keywordEntries: KeywordEntry[] = (rawEntries as KeywordEntry[]).filter(
        (e) => e && Array.isArray(e.includes) && e.includes.length > 0,
      );

      if (keywordEntries.length === 0) {
        unsubscribe();
        res.status(400).json({ error: "유효한 키워드를 입력해주세요." });
        return;
      }

      const parsedDays =
        typeof days === "number" && days >= 1 ? Math.floor(days) : 7;

      const searchMethod: SearchMethod =
        method === "api" ? "api" : method === "scraping" ? "scraping" : "auto";

      // 각 키워드 엔트리의 표시 레이블 (원본 raw 사용)
      const keywords = keywordEntries.map((e) => e.raw);

      logger.info(`검색 요청: ${keywords.length}개 키워드 (최근 ${parsedDays}일, 방법: ${searchMethod})`);

      // 각 키워드 엔트리별로 검색
      const articlesByKeyword: Record<string, SearchArticle[]> = {};
      let totalCount = 0;

      for (const entry of keywordEntries) {
        const label = entry.raw;
        // 네이버 검색 쿼리 빌드: include 키워드들을 공백으로 연결
        const searchQuery = entry.includes.join(" ");
        logger.info(`키워드 "${label}" → 검색어: "${searchQuery}" 검색 시작...`);

        let articles = await scrapeNaverNews(searchQuery, parsedDays, searchMethod);

        // 제외 키워드 필터링 (제목, 요약에서)
        if (entry.excludes.length > 0) {
          const beforeCount = articles.length;
          articles = articles.filter((a) => {
            const text = (a.title + " " + (a.summary || "")).toLowerCase();
            return !entry.excludes.some((ex) => text.includes(ex.toLowerCase()));
          });
          const filtered = beforeCount - articles.length;
          if (filtered > 0) {
            logger.info(`키워드 "${label}": 제외 필터로 ${filtered}건 제거 (${beforeCount} → ${articles.length})`);
          }
        }

        articlesByKeyword[label] = articles;
        totalCount += articles.length;
        logger.info(`키워드 "${label}" 검색 완료: ${articles.length}건`);
      }

      const analysisPrompt = typeof rawPrompt === "string" ? rawPrompt.trim() : "";

      const sessionId = crypto.randomUUID();
      const session: SessionData = {
        keywords,
        days: parsedDays,
        analysisPrompt,
        articlesByKeyword,
        status: "searched",
        sseClients: new Set(),
        logs: [],
        sendEmail: sendEmail === true,
      };
      sessions.set(sessionId, session);
      sessionCreatedAt.set(sessionId, Date.now());

      logger.info(
        `검색 완료: ${keywords.length}개 키워드 — 총 ${totalCount}건 (세션: ${sessionId})`,
      );

      unsubscribe();

      res.json({
        sessionId,
        keywords,
        articlesByKeyword,
        totalCount,
        logs: searchLogs,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "검색 중 오류가 발생했습니다.";
      logger.error("검색 API 오류", err);
      unsubscribe();
      res.status(500).json({ error: message, logs: searchLogs });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/process — 키워드별 선택 처리
  // -------------------------------------------------------------------------
  app.post("/api/process", (req, res) => {
    try {
      const { sessionId, selectedByKeyword } = req.body as {
        sessionId: unknown;
        selectedByKeyword: unknown;
      };

      if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
        res.status(400).json({ error: "유효하지 않은 세션입니다." });
        return;
      }

      const session = sessions.get(sessionId)!;

      if (session.status === "processing") {
        res.status(409).json({ error: "이미 처리가 진행 중입니다." });
        return;
      }

      if (!selectedByKeyword || typeof selectedByKeyword !== "object") {
        res.status(400).json({ error: "선택된 기사 목록이 필요합니다." });
        return;
      }

      // 키워드별 선택된 기사 수집
      const selected: SearchArticle[] = [];
      const selMap = selectedByKeyword as Record<string, number[]>;

      for (const [kw, indices] of Object.entries(selMap)) {
        const kwArticles = session.articlesByKeyword[kw];
        if (!kwArticles) continue;
        for (const idx of indices) {
          if (typeof idx === "number" && idx >= 0 && idx < kwArticles.length) {
            // 중복 방지 (같은 기사가 여러 키워드에 있을 수 있음)
            const article = kwArticles[idx];
            const key = article.naverLink || article.originalLink;
            if (!selected.some(a => (a.naverLink || a.originalLink) === key)) {
              selected.push(article);
            }
          }
        }
      }

      if (selected.length === 0) {
        res.status(400).json({ error: "유효한 기사가 선택되지 않았습니다." });
        return;
      }

      session.selectedArticles = selected;
      session.status = "processing";

      // Return immediately
      res.json({ ok: true });

      // Run pipeline in background
      runPipeline(session, sessionId, getClaude(), claudeModel).catch((err) => {
        logger.error("파이프라인 실행 오류", err);
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "처리 요청 중 오류가 발생했습니다.";
      logger.error("처리 API 오류", err);
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/progress/:sessionId — SSE
  // -------------------------------------------------------------------------
  app.get("/api/progress/:sessionId", (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);

    if (!session) {
      res.status(404).json({ error: "세션을 찾을 수 없습니다." });
      return;
    }

    // Set up SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    // Send any existing logs as catch-up
    for (const log of session.logs) {
      const payload = JSON.stringify({
        type: "log",
        level: log.level,
        message: log.message,
        timestamp: log.timestamp,
      });
      res.write(`data: ${payload}\n\n`);
    }

    // If already done, send completion immediately
    if (session.status === "done" && session.outputPath) {
      const filename = path.basename(session.outputPath);
      res.write(
        `data: ${JSON.stringify({ type: "done", filename })}\n\n`,
      );
    }

    // If errored, send error immediately
    if (session.status === "error") {
      res.write(
        `data: ${JSON.stringify({ type: "error", message: "처리 중 오류가 발생했습니다." })}\n\n`,
      );
    }

    session.sseClients.add(res);

    // Clean up on close
    req.on("close", () => {
      session.sseClients.delete(res);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/download/:filename
  // -------------------------------------------------------------------------
  app.get("/api/download/:filename", (req, res) => {
    try {
      const { filename } = req.params;

      // Prevent path traversal
      const sanitizedFilename = path.basename(filename);
      const filePath = path.join(ensureOutputDir(), sanitizedFilename);

      if (!fs.existsSync(filePath)) {
        res.status(404).json({ error: "파일을 찾을 수 없습니다." });
        return;
      }

      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(sanitizedFilename)}`,
      );
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      res.sendFile(filePath);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "다운로드 중 오류가 발생했습니다.";
      logger.error("다운로드 API 오류", err);
      res.status(500).json({ error: message });
    }
  });

  return { app };
}

// ---------------------------------------------------------------------------
// Processing pipeline (runs in background)
// ---------------------------------------------------------------------------

async function runPipeline(
  session: SessionData,
  sessionId: string,
  claude: Anthropic,
  claudeModel: string,
): Promise<void> {
  const totalSteps = session.sendEmail ? 5 : 4;
  const selectedArticles = session.selectedArticles!;
  const keywords = session.keywords;
  const keywordStr = keywords.join(", ");

  try {
    // Subscribe to the global logger so we capture module-level logs
    const unsubscribe = logger.subscribe((entry) => {
      const payload: Record<string, unknown> = {
        type: "log",
        level: entry.level,
        message: entry.message,
        timestamp: entry.timestamp,
      };
      const data = `data: ${JSON.stringify(payload)}\n\n`;
      for (const client of session.sseClients) {
        try {
          client.write(data);
        } catch {
          session.sseClients.delete(client);
        }
      }
    });

    // 단계별 진행률 가중치 (전체 100% 중)
    const stepWeights = [60, 20, 10, 10]; // extract, rank, summary, docx

    function broadcastDetailProgress(
      step: number,
      stepName: string,
      current: number,
      stepTotal: number,
      itemName: string,
    ): void {
      // 해당 단계까지의 누적 가중치 계산
      let basePct = 0;
      for (let s = 0; s < step - 1; s++) basePct += stepWeights[s];
      const stepPct = stepWeights[step - 1] || 10;
      const overallPercent = Math.round(basePct + (current / stepTotal) * stepPct);

      broadcastSSE(session, {
        type: "detail_progress",
        step,
        totalSteps,
        stepName,
        current,
        stepTotal,
        itemName,
        overallPercent,
      });
    }

    try {
      // Step 1: Extract article bodies
      sessionProgress(
        session,
        1,
        totalSteps,
        `기사 본문 추출 중... (${selectedArticles.length}건)`,
      );
      const articleDetails = await extractAllArticles(
        selectedArticles,
        claude,
        claudeModel,
        (current, total, itemName) => {
          broadcastDetailProgress(1, "기사 본문 추출", current, total, itemName);
        },
      );

      // Step 2: Rank by importance
      const analysisLabel = session.analysisPrompt ? "기사 분석·정렬" : "중요도 분석";
      sessionProgress(
        session,
        2,
        totalSteps,
        `${analysisLabel} 중...`,
      );
      const rankedArticles = await rankByImportance(
        articleDetails,
        claude,
        claudeModel,
        session.analysisPrompt,
        (current, total, itemName) => {
          broadcastDetailProgress(2, analysisLabel, current, total, itemName);
        },
      );

      // Step 3: Generate executive summary
      sessionProgress(
        session,
        3,
        totalSteps,
        "Executive Summary 생성 중...",
      );
      broadcastDetailProgress(3, "Executive Summary 생성", 1, 1, "AI 분석 중...");
      const executiveSummary = await generateExecutiveSummary(
        rankedArticles,
        keywordStr,
        claude,
        claudeModel,
        session.analysisPrompt,
      );

      // Step 4: Generate DOCX
      sessionProgress(session, 4, totalSteps, "DOCX 리포트 생성 중...");
      broadcastDetailProgress(4, "DOCX 파일 생성", 1, 1, "리포트 조립 중...");

      const outputDir = ensureOutputDir();
      const dateStr = getDateStr();
      const filenameKeyword = keywords[0] + (keywords.length > 1 ? `_외${keywords.length - 1}건` : "");
      const outputFilename = `뉴스클리핑_${filenameKeyword}_${dateStr}.docx`;
      const outputPath = path.join(outputDir, outputFilename);

      const config: ClipperConfig = {
        keyword: keywordStr,
        days: session.days,
        outputPath,
        claudeModel,
        port: 0,
      };

      const report: ClipperReport = {
        config,
        executiveSummary,
        articles: rankedArticles,
        generatedAt: new Date().toISOString(),
      };

      await generateDocx(report);

      // Step 5: Email (optional)
      let emailSent = false;
      if (session.sendEmail) {
        sessionProgress(session, 5, totalSteps, "메일 발송 중...");
        try {
          await sendEmailWithAttachment(outputPath, keywords);
          emailSent = true;
          sessionLog(session, "info", "메일 발송 완료!");
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          sessionLog(session, "error", `메일 발송 실패: ${errMsg}`);
        }
      }

      // Done
      session.status = "done";
      session.outputPath = outputPath;

      sessionLog(session, "info", `리포트 생성 완료: ${outputFilename}`);
      broadcastSSE(session, { type: "done", filename: outputFilename, emailSent });
    } finally {
      unsubscribe();
    }
  } catch (err) {
    session.status = "error";
    const message =
      err instanceof Error ? err.message : "처리 중 알 수 없는 오류가 발생했습니다.";
    sessionLog(session, "error", message);
    broadcastSSE(session, { type: "error", message });
    logger.error(`파이프라인 오류 (세션: ${sessionId})`, err);
  }
}
