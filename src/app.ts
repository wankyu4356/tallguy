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

    :root {
      --c-primary: #1a73e8;
      --c-primary-light: #e8f0fe;
      --c-primary-dark: #1557b0;
      --c-accent: #00c853;
      --c-bg: #f0f2f5;
      --c-surface: #ffffff;
      --c-text: #1d1d1f;
      --c-text-secondary: #6e6e73;
      --c-text-tertiary: #aeaeb2;
      --c-border: #e5e5ea;
      --c-border-light: #f2f2f7;
      --radius: 16px;
      --radius-sm: 10px;
      --radius-xs: 6px;
      --shadow-sm: 0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.06);
      --shadow-md: 0 4px 20px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04);
      --shadow-lg: 0 10px 40px rgba(0,0,0,0.08);
      --transition: 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
        'Noto Sans KR', 'Malgun Gothic', sans-serif;
      background: var(--c-bg);
      color: var(--c-text);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }

    .container {
      max-width: 960px;
      margin: 0 auto;
      padding: 32px 24px 64px;
    }

    /* ---- Header ---- */
    .app-header {
      text-align: center;
      margin-bottom: 36px;
      padding: 28px 0 20px;
    }
    .app-header h1 {
      font-size: 26px;
      font-weight: 800;
      color: var(--c-text);
      letter-spacing: -0.5px;
      margin-bottom: 6px;
    }
    .app-header h1 span.accent {
      background: linear-gradient(135deg, var(--c-primary), var(--c-accent));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .app-header p {
      color: var(--c-text-secondary);
      font-size: 14px;
      font-weight: 400;
    }

    /* ---- Step indicator ---- */
    .step-nav {
      display: flex;
      justify-content: center;
      gap: 0;
      margin-bottom: 28px;
    }
    .step-nav-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 600;
      color: var(--c-text-tertiary);
      position: relative;
    }
    .step-nav-item .step-num {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
      background: var(--c-border);
      color: var(--c-text-tertiary);
      flex-shrink: 0;
    }
    .step-nav-item.active .step-num {
      background: var(--c-primary);
      color: #fff;
    }
    .step-nav-item.active { color: var(--c-primary); }
    .step-nav-item.done .step-num {
      background: var(--c-accent);
      color: #fff;
    }
    .step-nav-item.done { color: var(--c-text-secondary); }
    .step-nav-connector {
      width: 32px;
      height: 2px;
      background: var(--c-border);
      align-self: center;
    }
    .step-nav-connector.done { background: var(--c-accent); }

    /* ---- Sections ---- */
    .section {
      display: none;
      background: var(--c-surface);
      border-radius: var(--radius);
      box-shadow: var(--shadow-md);
      padding: 36px 32px;
      margin-bottom: 24px;
      border: 1px solid var(--c-border-light);
      animation: fadeSlideIn 0.35s ease-out;
    }
    .section.active { display: block; }
    @keyframes fadeSlideIn {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .section-title {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 24px;
      color: var(--c-text);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .section-title::before {
      content: '';
      width: 4px;
      height: 20px;
      background: var(--c-primary);
      border-radius: 2px;
      flex-shrink: 0;
    }

    /* ---- Forms ---- */
    .form-group { margin-bottom: 20px; }
    .form-group label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: var(--c-text-secondary);
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .form-group input[type="text"],
    .form-group input[type="number"],
    .form-group input[type="email"],
    .form-group input[type="password"],
    .form-group textarea {
      width: 100%;
      max-width: 520px;
      padding: 11px 14px;
      border: 1.5px solid var(--c-border);
      border-radius: var(--radius-sm);
      font-size: 14px;
      font-family: inherit;
      color: var(--c-text);
      background: var(--c-surface);
      transition: border-color var(--transition), box-shadow var(--transition);
      outline: none;
    }
    .form-group input:focus,
    .form-group textarea:focus {
      border-color: var(--c-primary);
      box-shadow: 0 0 0 3px rgba(26,115,232,0.12);
    }
    .form-group .hint {
      font-size: 12px;
      color: var(--c-text-tertiary);
      margin-top: 5px;
      line-height: 1.5;
    }

    /* ---- Keyword chips ---- */
    .keyword-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
      min-height: 0;
    }
    .keyword-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 500;
      background: var(--c-primary-light);
      border: 1px solid #c5d9f0;
      color: var(--c-primary-dark);
      line-height: 1.4;
      transition: all var(--transition);
    }
    .keyword-chip:hover { box-shadow: var(--shadow-sm); }
    .keyword-chip .kw-term {
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .kw-include {
      background: #d4edda;
      color: #155724;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      display: inline-block;
    }
    .kw-exclude {
      background: #f8d7da;
      color: #721c24;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      text-decoration: line-through;
      display: inline-block;
    }
    .keyword-chip .kw-remove {
      cursor: pointer;
      font-size: 15px;
      color: var(--c-text-tertiary);
      margin-left: 2px;
      line-height: 1;
      width: 18px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      transition: all var(--transition);
    }
    .keyword-chip .kw-remove:hover { color: #dc3545; background: rgba(220,53,69,0.1); }

    /* ---- Guide box ---- */
    .guide-box {
      background: #fafbfc;
      border: 1px solid var(--c-border);
      border-radius: var(--radius-sm);
      padding: 16px 18px;
      font-size: 13px;
      line-height: 1.8;
      color: var(--c-text-secondary);
    }
    .guide-box .guide-title {
      font-weight: 700;
      font-size: 13px;
      margin-bottom: 8px;
      color: var(--c-text);
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .guide-box code {
      background: var(--c-primary-light);
      padding: 2px 7px;
      border-radius: var(--radius-xs);
      font-size: 12px;
      color: var(--c-primary-dark);
      font-weight: 600;
    }
    .guide-box .guide-example { margin: 5px 0; }
    .guide-box .guide-arrow { color: var(--c-text-tertiary); margin: 0 6px; }

    /* ---- Buttons ---- */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 10px 22px;
      border: 1.5px solid var(--c-border);
      border-radius: var(--radius-sm);
      background: var(--c-surface);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all var(--transition);
      font-family: inherit;
      color: var(--c-text);
    }
    .btn:hover { background: #f8f9fa; border-color: #d0d0d5; transform: translateY(-1px); box-shadow: var(--shadow-sm); }
    .btn:active { transform: translateY(0); }
    .btn:disabled { opacity: 0.45; cursor: not-allowed; transform: none !important; }
    .btn-primary {
      background: var(--c-primary);
      color: #fff;
      border-color: var(--c-primary);
      font-weight: 600;
      font-size: 15px;
      padding: 12px 36px;
    }
    .btn-primary:hover { background: var(--c-primary-dark); border-color: var(--c-primary-dark); box-shadow: 0 4px 12px rgba(26,115,232,0.25); }
    .btn-primary:disabled { background: #93bfec; border-color: #93bfec; box-shadow: none; }
    .btn-secondary {
      background: #f8f9fa;
      border-color: var(--c-border);
    }
    .btn-secondary:hover { background: #eef0f2; }
    .btn-sm { padding: 6px 14px; font-size: 12px; border-radius: 8px; }

    /* ---- Keyword group ---- */
    .keyword-group {
      margin-bottom: 16px;
      border: 1px solid var(--c-border);
      border-radius: var(--radius-sm);
      overflow: hidden;
      transition: box-shadow var(--transition);
    }
    .keyword-group:hover { box-shadow: var(--shadow-sm); }
    .keyword-group-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 18px;
      background: #fafbfc;
      border-bottom: 1px solid var(--c-border-light);
      cursor: pointer;
      user-select: none;
      transition: background var(--transition);
    }
    .keyword-group-header:hover { background: #f3f4f6; }
    .keyword-group-header .kw-name {
      font-weight: 700;
      font-size: 14px;
      color: var(--c-text);
    }
    .keyword-group-header .kw-count {
      font-size: 12px;
      color: var(--c-text-secondary);
      background: var(--c-border);
      padding: 3px 10px;
      border-radius: 12px;
      font-weight: 600;
    }
    .keyword-group-header .kw-actions {
      margin-left: auto;
      display: flex;
      gap: 6px;
    }
    .keyword-group-header .kw-toggle {
      font-size: 11px;
      color: var(--c-text-tertiary);
      transition: transform var(--transition);
    }
    .keyword-group.collapsed .keyword-group-body { display: none; }
    .keyword-group.collapsed .kw-toggle { transform: rotate(-90deg); }

    /* ---- Article table ---- */
    .article-controls {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .article-controls .count {
      margin-left: auto;
      font-size: 13px;
      color: var(--c-text-secondary);
      font-weight: 600;
    }

    .article-table {
      width: 100%;
      border-collapse: collapse;
    }
    .article-table thead { background: #f8f9fb; }
    .article-table th {
      padding: 10px 14px;
      text-align: left;
      font-size: 11px;
      font-weight: 700;
      color: var(--c-text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1.5px solid var(--c-border);
      white-space: nowrap;
    }
    .article-table td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--c-border-light);
      font-size: 14px;
      color: var(--c-text);
    }
    .article-table tbody tr { transition: background var(--transition); }
    .article-table tbody tr:hover { background: #f6f8ff; }
    .article-table .col-check { width: 40px; text-align: center; }
    .article-table .col-idx { width: 44px; text-align: center; color: var(--c-text-tertiary); font-size: 13px; }
    .article-table .col-title a {
      color: var(--c-primary);
      text-decoration: none;
      line-height: 1.5;
      font-weight: 500;
    }
    .article-table .col-title a:hover { text-decoration: underline; }
    .article-table .col-title a:visited { color: #7b61a6; }
    .article-table .col-kw { width: 130px; white-space: nowrap; }
    .article-table .col-press { width: 120px; color: var(--c-text-secondary); white-space: nowrap; font-size: 13px; }
    .article-table .col-date { width: 100px; color: var(--c-text-tertiary); white-space: nowrap; font-size: 13px; }

    /* Keyword context snippet */
    .keyword-context {
      font-size: 12px;
      color: var(--c-text-tertiary);
      margin-top: 4px;
      line-height: 1.5;
    }
    .keyword-context mark {
      background: #fef3cd;
      color: #856404;
      padding: 1px 4px;
      border-radius: 3px;
      font-weight: 600;
    }

    input[type="checkbox"] {
      width: 17px;
      height: 17px;
      cursor: pointer;
      accent-color: var(--c-primary);
      border-radius: 4px;
    }

    /* ---- Progress ---- */
    .progress-info { margin-bottom: 24px; }
    .step-label {
      font-size: 15px;
      font-weight: 600;
      color: var(--c-text);
      margin-bottom: 10px;
    }
    .progress-bar-track {
      width: 100%;
      height: 10px;
      background: var(--c-border-light);
      border-radius: 5px;
      overflow: hidden;
    }
    .progress-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--c-primary), #4fc3f7);
      border-radius: 5px;
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
        rgba(255,255,255,0.4) 50%,
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
      background: #1a1b1e;
      color: #c9d1d9;
      font-family: 'SF Mono', 'Consolas', 'Monaco', 'Courier New', monospace;
      font-size: 12px;
      line-height: 1.8;
      padding: 18px;
      border-radius: var(--radius-sm);
      max-height: 360px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      border: 1px solid #30363d;
    }
    .log-area .log-info { color: #79c0ff; }
    .log-area .log-warn { color: #d29922; }
    .log-area .log-error { color: #f85149; }
    .log-area .log-time { color: #7ee787; }

    /* ---- Complete section ---- */
    .complete-content { text-align: center; padding: 48px 0; }
    .complete-icon {
      font-size: 56px;
      margin-bottom: 16px;
      display: block;
    }
    .complete-msg {
      font-size: 22px;
      font-weight: 800;
      color: var(--c-text);
      margin-bottom: 6px;
      letter-spacing: -0.3px;
    }
    .complete-sub {
      font-size: 14px;
      color: var(--c-text-secondary);
      margin-bottom: 32px;
    }
    .complete-actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }

    /* ---- Error display ---- */
    .error-box {
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: var(--radius-sm);
      padding: 14px 18px;
      color: #dc2626;
      margin-bottom: 16px;
      display: none;
      font-size: 14px;
      font-weight: 500;
    }
    .error-box.visible { display: block; animation: fadeSlideIn 0.25s ease-out; }

    /* ---- Email toggle ---- */
    .email-toggle {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      background: var(--c-primary-light);
      border: 1px solid #c5d9f0;
      border-radius: var(--radius-sm);
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
      color: var(--c-text-secondary);
      margin-left: auto;
    }

    /* ---- Settings groups ---- */
    .settings-group {
      margin-top: 28px;
      padding-top: 24px;
      border-top: 1.5px solid var(--c-border-light);
    }
    .settings-group-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--c-text);
      margin-bottom: 14px;
    }

    /* ---- Spinner ---- */
    .spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2.5px solid var(--c-border);
      border-top-color: var(--c-primary);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      vertical-align: middle;
      margin-right: 8px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ---- Scrollbar ---- */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #d0d0d5; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #b0b0b5; }

    /* ---- Fun fact card ---- */
    .fun-fact-card {
      margin-top: 24px;
      padding: 20px 22px;
      background: linear-gradient(135deg, #fafbfc 0%, #f0f4ff 100%);
      border: 1px solid var(--c-border);
      border-radius: var(--radius-sm);
      position: relative;
      cursor: pointer;
      transition: all var(--transition);
    }
    .fun-fact-card:hover { box-shadow: var(--shadow-sm); border-color: #c5d9f0; }
    .fun-fact-cat {
      display: inline-block;
      font-size: 11px;
      font-weight: 700;
      color: var(--c-primary);
      background: var(--c-primary-light);
      padding: 3px 10px;
      border-radius: 12px;
      margin-bottom: 10px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .fun-fact-text {
      font-size: 14px;
      line-height: 1.7;
      color: var(--c-text);
    }
    .fun-fact-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 12px;
    }
    .fun-fact-label {
      font-size: 11px;
      color: var(--c-text-tertiary);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .fun-fact-next {
      font-size: 12px;
      color: var(--c-primary);
      font-weight: 600;
      background: none;
      border: none;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: var(--radius-xs);
      transition: background var(--transition);
    }
    .fun-fact-next:hover { background: var(--c-primary-light); }

    /* ---- Quiz overlay ---- */
    .quiz-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.6);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
      animation: fadeIn 0.3s ease-out;
      padding: 20px;
    }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    .quiz-modal {
      background: var(--c-surface);
      border-radius: 20px;
      box-shadow: var(--shadow-lg), 0 0 0 1px rgba(0,0,0,0.05);
      padding: 36px 32px;
      max-width: 520px;
      width: 100%;
      animation: modalSlideIn 0.35s ease-out;
    }
    @keyframes modalSlideIn {
      from { opacity: 0; transform: translateY(20px) scale(0.97); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .quiz-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 700;
      color: #e67e22;
      background: #fef5e7;
      border: 1px solid #fde8c8;
      padding: 5px 14px;
      border-radius: 20px;
      margin-bottom: 20px;
    }
    .quiz-question {
      font-size: 17px;
      font-weight: 700;
      color: var(--c-text);
      line-height: 1.6;
      margin-bottom: 24px;
    }
    .quiz-options {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .quiz-option {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 14px 18px;
      border: 1.5px solid var(--c-border);
      border-radius: var(--radius-sm);
      background: var(--c-surface);
      cursor: pointer;
      transition: all var(--transition);
      font-size: 14px;
      line-height: 1.6;
      color: var(--c-text);
      text-align: left;
    }
    .quiz-option:hover { border-color: var(--c-primary); background: var(--c-primary-light); }
    .quiz-option .opt-num {
      flex-shrink: 0;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      background: #f0f1f3;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
      color: var(--c-text-secondary);
      margin-top: 1px;
    }
    .quiz-option:hover .opt-num { background: var(--c-primary); color: #fff; }
    .quiz-option.correct {
      border-color: #00c853;
      background: #e8f5e9;
      animation: correctPulse 0.5s ease-out;
    }
    .quiz-option.correct .opt-num { background: #00c853; color: #fff; }
    @keyframes correctPulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.02); }
      100% { transform: scale(1); }
    }
    .quiz-option.wrong {
      border-color: #ef5350;
      background: #fef2f2;
    }
    .quiz-option.wrong .opt-num { background: #ef5350; color: #fff; }
    .quiz-result {
      margin-top: 16px;
      padding: 12px 16px;
      border-radius: var(--radius-sm);
      font-size: 14px;
      font-weight: 600;
      text-align: center;
      display: none;
    }
    .quiz-result.wrong-msg {
      display: block;
      background: #fef2f2;
      color: #dc2626;
      border: 1px solid #fecaca;
      animation: shake 0.4s ease-out;
    }
    .quiz-result.correct-msg {
      display: block;
      background: #e8f5e9;
      color: #2e7d32;
      border: 1px solid #c8e6c9;
    }
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      20% { transform: translateX(-8px); }
      40% { transform: translateX(8px); }
      60% { transform: translateX(-4px); }
      80% { transform: translateX(4px); }
    }

    /* ---- Responsive ---- */
    @media (max-width: 640px) {
      .container { padding: 16px 12px 48px; }
      .section { padding: 24px 18px; border-radius: 12px; }
      .btn-primary { width: 100%; justify-content: center; }
      .step-nav-item span:not(.step-num) { display: none; }
      .step-nav-connector { width: 20px; }
      .quiz-modal { padding: 28px 22px; }
    }
  </style>
</head>
<body>
  <!-- Quiz Overlay (5% chance) -->
  <div class="quiz-overlay" id="quizOverlay" style="display:none;">
    <div class="quiz-modal">
      <div class="quiz-badge">&#x1F9E0; 알쓸신잡 퀴즈</div>
      <div class="quiz-question" id="quizQuestion"></div>
      <div class="quiz-options" id="quizOptions"></div>
      <div class="quiz-result" id="quizResult"></div>
    </div>
  </div>

  <div class="container">
    <!-- Header -->
    <div class="app-header">
      <h1><span class="accent">N</span> 뉴스 클리퍼</h1>
      <p>네이버 뉴스 검색 &middot; AI 분석 &middot; DOCX 리포트</p>
    </div>

    <!-- Step Navigator -->
    <div class="step-nav" id="stepNav">
      <div class="step-nav-item active" data-step="0"><span class="step-num">1</span><span>설정</span></div>
      <div class="step-nav-connector"></div>
      <div class="step-nav-item" data-step="1"><span class="step-num">2</span><span>검색</span></div>
      <div class="step-nav-connector"></div>
      <div class="step-nav-item" data-step="2"><span class="step-num">3</span><span>선택</span></div>
      <div class="step-nav-connector"></div>
      <div class="step-nav-item" data-step="3"><span class="step-num">4</span><span>분석</span></div>
      <div class="step-nav-connector"></div>
      <div class="step-nav-item" data-step="4"><span class="step-num">5</span><span>완료</span></div>
    </div>

    <!-- Global Error -->
    <div class="error-box" id="globalError"></div>

    <!-- Section 0: Setup -->
    <div class="section" id="sectionSetup">
      <div class="section-title">초기 설정</div>
      <p style="color:var(--c-text-secondary);margin-bottom:24px;font-size:14px;">서비스를 사용하려면 API 키를 입력하세요. 설정은 .env 파일에 저장됩니다.</p>
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
              <input type="radio" name="method" value="auto" checked style="accent-color:var(--c-primary);" /> 자동 (API 우선)
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-weight:400;cursor:pointer;">
              <input type="radio" name="method" value="api" style="accent-color:var(--c-primary);" /> 네이버 API
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-weight:400;cursor:pointer;">
              <input type="radio" name="method" value="scraping" style="accent-color:var(--c-primary);" /> 웹 스크래핑
            </label>
          </div>
        </div>
        <div id="emailToggleArea"></div>
        <button type="submit" class="btn btn-primary" id="searchBtn">검색 시작</button>
      </form>
      <div class="log-area" id="searchLogArea" style="display:none;margin-top:20px;"></div>
      <!-- Fun Fact -->
      <div class="fun-fact-card" id="funFactCard" onclick="showNextFact()">
        <div class="fun-fact-cat" id="funFactCat"></div>
        <div class="fun-fact-text" id="funFactText"></div>
        <div class="fun-fact-footer">
          <span class="fun-fact-label">&#x1F4A1; 알쓸신잡</span>
          <button type="button" class="fun-fact-next" onclick="event.stopPropagation();showNextFact()">다른 사실 보기 &rarr;</button>
        </div>
      </div>
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
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px;">
          <div class="step-label" id="stepLabel" style="margin-bottom:0;flex:1;"><span class="spinner"></span>준비 중...</div>
          <div id="progressPercent" style="font-size:28px;font-weight:800;color:var(--c-primary);min-width:64px;text-align:right;letter-spacing:-1px;">0%</div>
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" id="progressBar"></div>
        </div>
        <!-- 세부 진행 상황 -->
        <div id="detailProgress" style="margin-top:16px;padding:16px 18px;background:#f8f9fb;border-radius:10px;border:1px solid var(--c-border-light);display:none;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
            <span id="detailStepName" style="font-size:13px;font-weight:700;color:var(--c-text);"></span>
            <span id="detailCount" style="font-size:12px;color:var(--c-text-secondary);font-weight:600;"></span>
          </div>
          <div style="width:100%;height:6px;background:var(--c-border);border-radius:3px;overflow:hidden;margin-bottom:10px;">
            <div id="detailBar" style="height:100%;background:#4fc3f7;border-radius:3px;transition:width 0.3s;width:0%;"></div>
          </div>
          <div id="detailItem" style="font-size:13px;color:var(--c-text-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
          <div id="detailEta" style="font-size:12px;color:var(--c-text-tertiary);margin-top:4px;"></div>
        </div>
      </div>
      <div class="log-area" id="logArea"></div>
    </div>

    <!-- Section 4: Complete -->
    <div class="section" id="sectionComplete">
      <div class="complete-content">
        <div style="width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,#e8f5e9,#c8e6c9);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#2e7d32" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
        </div>
        <div class="complete-msg">리포트가 준비되었습니다</div>
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
        // 반각 괄호 () 또는 전각 괄호 （） 모두 지원
        if ((p.charAt(0) === '(' && p.charAt(p.length - 1) === ')') ||
            (p.charAt(0) === '\uFF08' && p.charAt(p.length - 1) === '\uFF09')) {
          excludes.push(p.slice(1, -1).trim());
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

    function makeKwTag(text, isExclude) {
      if (isExclude) {
        return '<span style="background:#ffcdd2;color:#c62828;padding:1px 6px;border-radius:10px;font-size:12px;font-weight:600;text-decoration:line-through;display:inline-block;">' + escapeHtml(text) + '</span>';
      }
      return '<span style="background:#c8e6c9;color:#1b5e20;padding:1px 6px;border-radius:10px;font-size:12px;font-weight:600;display:inline-block;">' + escapeHtml(text) + '</span>';
    }

    function renderKeywordChips() {
      var container = document.getElementById('keywordChips');
      container.innerHTML = '';
      keywordEntries.forEach(function(entry, idx) {
        var chip = document.createElement('span');
        chip.className = 'keyword-chip';
        var termsHtml = '';
        entry.includes.forEach(function(t) {
          termsHtml += makeKwTag(t, false) + ' ';
        });
        entry.excludes.forEach(function(t) {
          termsHtml += makeKwTag(t, true) + ' ';
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
      // Sync step navigator
      var stepMap = { sectionSetup: 0, sectionSearch: 1, sectionResults: 2, sectionProgress: 3, sectionComplete: 4 };
      var currentStep = stepMap[id] != null ? stepMap[id] : -1;
      var items = document.querySelectorAll('.step-nav-item');
      var connectors = document.querySelectorAll('.step-nav-connector');
      items.forEach(function(item, i) {
        item.classList.remove('active', 'done');
        if (i < currentStep) item.classList.add('done');
        else if (i === currentStep) item.classList.add('active');
      });
      connectors.forEach(function(c, i) {
        c.classList.toggle('done', i < currentStep);
      });
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

      // 기준기간 표시
      var days = parseInt(document.getElementById('days').value, 10) || 7;
      var endDate = new Date();
      var startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      var fmt = function(d) {
        return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0');
      };
      var periodDiv = document.createElement('div');
      periodDiv.style.cssText = 'margin-bottom:16px;padding:10px 16px;background:#f8f9fb;border:1px solid #e5e5ea;border-radius:10px;font-size:13px;color:#6e6e73;';
      periodDiv.innerHTML = '<strong>기준기간:</strong> ' + fmt(startDate) + ' ~ ' + fmt(endDate) + ' (' + days + '일)';
      container.appendChild(periodDiv);

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
          kwTagsHtml += makeKwTag(t, false) + ' ';
        });
        parsed.excludes.forEach(function(t) {
          kwTagsHtml += makeKwTag(t, true) + ' ';
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
            cellKwHtml += makeKwTag(t, false) + ' ';
          });
          parsed.excludes.forEach(function(t) {
            cellKwHtml += makeKwTag(t, true) + ' ';
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

    // -----------------------------------------------------------------------
    // Fun Facts & Quiz
    // -----------------------------------------------------------------------
    var FACTS = [
      {cat:"동물 & 자연",text:"문어는 심장이 3개인데, 수영할 때는 그 중 하나가 멈춘다. 그래서 문어는 수영보다 걷는 걸 선호한다."},
      {cat:"동물 & 자연",text:"바나나는 식물학적으로 '베리'이고, 딸기는 베리가 아니다. 세상이 우리에게 거짓말을 하고 있다."},
      {cat:"동물 & 자연",text:"고양이는 야옹 소리를 오직 인간에게만 낸다. 고양이끼리는 야옹하지 않는다."},
      {cat:"역사 & 문명",text:"클레오파트라가 살던 시대는 아이폰 출시 시점에 더 가깝다. 피라미드 건설 시점보다."},
      {cat:"역사 & 문명",text:"닌텐도는 1889년에 설립됐다. 화투 카드를 만드는 회사로 시작했다."},
      {cat:"우주 & 과학",text:"토성은 물에 뜬다. 밀도가 물보다 낮은 유일한 행성이다. (물론 그만큼 큰 욕조는 없다.)"},
      {cat:"우주 & 과학",text:"화성의 일몰은 파란색이다. 지구의 석양은 붉고, 화성의 석양은 푸르다."},
      {cat:"음식 & 일상",text:"꿀은 상하지 않는다. 3,000년 된 이집트 무덤의 꿀도 먹을 수 있었다."},
      {cat:"기술 & 디지털",text:"CAPTCHA를 풀 때마다 당신은 무료로 AI 학습 데이터를 라벨링해주고 있는 것이다."},
      {cat:"잡학 & 반전",text:"라이터는 성냥보다 먼저 발명됐다. 라이터 1823년, 성냥 1826년."}
    ];

    var QUIZ = [
      {q:"문어의 심장은 몇 개일까?",o:["2개","3개","5개"],a:1},
      {q:"다음 중 식물학적으로 '베리(berry)'에 해당하는 것은?",o:["딸기","바나나","체리"],a:1},
      {q:"닌텐도가 설립된 연도는?",o:["1923년","1889년","1945년"],a:1},
      {q:"토성이 특별한 이유는?",o:["가장 빠르게 자전한다","물에 뜰 수 있다","고리가 3개다"],a:1},
      {q:"라이터와 성냥 중 먼저 발명된 것은?",o:["성냥","동시에 발명","라이터"],a:2}
    ];

    var lastFactIdx = -1;
    function showNextFact() {
      if (FACTS.length === 0) return;
      var idx;
      do { idx = Math.floor(Math.random() * FACTS.length); } while (idx === lastFactIdx && FACTS.length > 1);
      lastFactIdx = idx;
      var f = FACTS[idx];
      var catEl = document.getElementById('funFactCat');
      var textEl = document.getElementById('funFactText');
      if (catEl) catEl.textContent = f.cat;
      if (textEl) textEl.textContent = f.text;
    }

    var quizCorrectAnswer = -1;
    function showQuiz() {
      if (QUIZ.length === 0) return;
      var q = QUIZ[Math.floor(Math.random() * QUIZ.length)];
      quizCorrectAnswer = q.a;
      document.getElementById('quizQuestion').textContent = q.q;
      var optHtml = '';
      var labels = ['A','B','C'];
      q.o.forEach(function(opt, i) {
        optHtml += '<div class="quiz-option" onclick="checkAnswer(' + i + ',this)">' +
          '<span class="opt-num">' + labels[i] + '</span>' +
          '<span>' + escapeHtml(opt) + '</span></div>';
      });
      document.getElementById('quizOptions').innerHTML = optHtml;
      document.getElementById('quizResult').className = 'quiz-result';
      document.getElementById('quizResult').textContent = '';
      document.getElementById('quizOverlay').style.display = 'flex';
    }

    function checkAnswer(idx, el) {
      var result = document.getElementById('quizResult');
      if (idx === quizCorrectAnswer) {
        el.classList.add('correct');
        result.className = 'quiz-result correct-msg';
        result.textContent = '정답! 대단해요 🎉';
        setTimeout(function() {
          document.getElementById('quizOverlay').style.display = 'none';
        }, 1200);
      } else {
        el.classList.add('wrong');
        result.className = 'quiz-result wrong-msg';
        result.textContent = '오답! 다시 도전하세요 😅';
        setTimeout(function() {
          showQuiz();
        }, 1500);
      }
    }

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

        // Show initial fun fact
        showNextFact();
        // 5% chance quiz gate
        if (Math.random() < 0.05) { showQuiz(); }

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
        analysisPrompt: session.analysisPrompt || "",
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
