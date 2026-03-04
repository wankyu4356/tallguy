import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
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
  keyword: string;
  days: number;
  articles: SearchArticle[];
  selectedArticles?: SearchArticle[];
  status: "searched" | "processing" | "done" | "error";
  outputPath?: string;
  sseClients: Set<express.Response>;
  logs: Array<{ level: string; message: string; timestamp: string }>;
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
  broadcastSSE(session, { type: "progress", step, totalSteps, message });
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
    .form-group input[type="number"] {
      width: 100%;
      max-width: 400px;
      padding: 10px 14px;
      border: 1px solid #ddd;
      border-radius: 8px;
      font-size: 15px;
      transition: border-color 0.2s;
      outline: none;
    }
    .form-group input:focus { border-color: #03c75a; }

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

    .article-table-wrapper {
      overflow-x: auto;
      border-radius: 8px;
      border: 1px solid #eee;
    }
    .article-table {
      width: 100%;
      border-collapse: collapse;
    }
    .article-table thead { background: #fafafa; }
    .article-table th {
      padding: 12px 14px;
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
    .article-table .col-press { width: 130px; color: #555; white-space: nowrap; }
    .article-table .col-date { width: 110px; color: #999; white-space: nowrap; }
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
      <div class="section-title">⚙️ 초기 설정</div>
      <p style="color:#666;margin-bottom:20px;">서비스를 사용하려면 API 키를 입력하세요. 설정은 .env 파일에 저장됩니다.</p>
      <form id="setupForm">
        <div class="form-group">
          <label for="setupAnthropicKey">Anthropic API Key (필수)</label>
          <input type="text" id="setupAnthropicKey" placeholder="sk-ant-..." required
                 style="max-width:500px;font-family:monospace;" />
        </div>
        <div class="form-group">
          <label for="setupClaudeModel">Claude 모델</label>
          <input type="text" id="setupClaudeModel" value="" placeholder="claude-sonnet-4-20250514"
                 style="max-width:400px;font-family:monospace;" />
        </div>
        <div class="form-group">
          <label for="setupNaverId">네이버 Client ID (선택)</label>
          <input type="text" id="setupNaverId" placeholder=""
                 style="max-width:400px;font-family:monospace;" />
        </div>
        <div class="form-group">
          <label for="setupNaverSecret">네이버 Client Secret (선택)</label>
          <input type="text" id="setupNaverSecret" placeholder=""
                 style="max-width:400px;font-family:monospace;" />
        </div>
        <button type="submit" class="btn btn-primary" id="setupBtn">저장 및 시작</button>
      </form>
    </div>

    <!-- Section 1: Search -->
    <div class="section" id="sectionSearch">
      <div class="section-title">검색 설정</div>
      <form id="searchForm">
        <div class="form-group">
          <label for="keyword">검색 키워드 (필수)</label>
          <input type="text" id="keyword" name="keyword" required
                 placeholder="예: 삼성전자 인수합병" autocomplete="off" />
        </div>
        <div class="form-group">
          <label for="days">검색 기간 (일)</label>
          <input type="number" id="days" name="days" value="7" min="1" max="365" />
        </div>
        <div class="form-group">
          <label>검색 방법</label>
          <div style="display:flex;gap:16px;margin-top:4px;">
            <label style="display:flex;align-items:center;gap:6px;font-weight:400;cursor:pointer;">
              <input type="radio" name="method" value="auto" checked style="accent-color:#03c75a;" /> 자동 (API 우선→스크래핑 폴백)
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-weight:400;cursor:pointer;">
              <input type="radio" name="method" value="api" style="accent-color:#03c75a;" /> 네이버 API
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-weight:400;cursor:pointer;">
              <input type="radio" name="method" value="scraping" style="accent-color:#03c75a;" /> 웹 스크래핑
            </label>
          </div>
        </div>
        <button type="submit" class="btn btn-primary" id="searchBtn">검색 시작</button>
      </form>
      <div class="log-area" id="searchLogArea" style="display:none;margin-top:20px;"></div>
    </div>

    <!-- Section 2: Results -->
    <div class="section" id="sectionResults">
      <div class="section-title">검색 결과 — <span id="resultKeyword"></span></div>
      <div class="article-controls">
        <button type="button" class="btn btn-secondary" onclick="selectAllArticles()">전체 선택</button>
        <button type="button" class="btn btn-secondary" onclick="deselectAllArticles()">전체 해제</button>
        <span class="count" id="articleCount"></span>
      </div>
      <div class="article-table-wrapper">
        <table class="article-table">
          <thead>
            <tr>
              <th class="col-check">
                <input type="checkbox" id="headerCheckbox" checked onchange="toggleAllArticles(this)" />
              </th>
              <th class="col-idx">#</th>
              <th>기사 제목</th>
              <th class="col-press">언론사</th>
              <th class="col-date">날짜</th>
            </tr>
          </thead>
          <tbody id="articleTableBody"></tbody>
        </table>
      </div>
      <div style="margin-top: 20px; text-align: right;">
        <button type="button" class="btn btn-primary" id="processBtn"
                onclick="startProcessing()">선택 완료 및 분석 시작</button>
      </div>
    </div>

    <!-- Section 3: Processing -->
    <div class="section" id="sectionProgress">
      <div class="section-title">분석 진행 중</div>
      <div class="progress-info">
        <div class="step-label" id="stepLabel"><span class="spinner"></span>준비 중...</div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" id="progressBar"></div>
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
    let currentSessionId = null;
    let currentArticles = [];
    let eventSource = null;

    // -----------------------------------------------------------------------
    // Utility
    // -----------------------------------------------------------------------
    function escapeHtml(str) {
      const div = document.createElement('div');
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

    function updateArticleCount() {
      var checked = document.querySelectorAll('.article-cb:checked').length;
      document.getElementById('articleCount').textContent =
        '선택: ' + checked + ' / ' + currentArticles.length + '건';
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
        if (log.level === 'debug') levelClass = 'log-info';

        var time = '';
        try { time = new Date(log.timestamp).toLocaleTimeString('ko-KR'); } catch(e) {}

        var line = document.createElement('div');
        var text = escapeHtml(log.message);
        if (log.details) { text += '\\n  → ' + escapeHtml(log.details.substring(0, 300)); }
        line.innerHTML =
          '<span class="log-time">[' + escapeHtml(time) + ']</span> ' +
          '<span class="' + levelClass + '">' + text + '</span>';
        area.appendChild(line);
      });
      area.scrollTop = area.scrollHeight;
    }

    document.getElementById('searchForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      var keyword = document.getElementById('keyword').value.trim();
      var days = parseInt(document.getElementById('days').value, 10);
      var methodEl = document.querySelector('input[name="method"]:checked');
      var method = methodEl ? methodEl.value : 'auto';
      if (!keyword) { showError('키워드를 입력해주세요.'); return; }
      if (isNaN(days) || days < 1) { days = 7; }

      var btn = document.getElementById('searchBtn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>검색 중...';
      document.getElementById('searchLogArea').style.display = 'none';

      try {
        var res = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keyword: keyword, days: days, method: method })
        });
        var data = await res.json();

        if (!res.ok) {
          renderSearchLogs(data.logs);
          throw new Error(data.error || '검색 실패');
        }

        currentSessionId = data.sessionId;
        currentArticles = data.articles;

        if (data.count === 0) {
          showError('검색 결과가 없습니다. 키워드나 기간을 변경해보세요.');
          renderSearchLogs(data.logs);
          btn.disabled = false;
          btn.textContent = '검색 시작';
          return;
        }

        renderSearchLogs(null);
        renderArticleTable(data.articles, keyword);
        showSection('sectionResults');
      } catch (err) {
        showError(err.message || '검색 중 오류가 발생했습니다.');
      } finally {
        btn.disabled = false;
        btn.textContent = '검색 시작';
      }
    });

    // -----------------------------------------------------------------------
    // Section 2: Article Selection
    // -----------------------------------------------------------------------
    function renderArticleTable(articles, keyword) {
      document.getElementById('resultKeyword').textContent = '"' + escapeHtml(keyword) + '" ' + articles.length + '건';

      var tbody = document.getElementById('articleTableBody');
      tbody.innerHTML = '';

      articles.forEach(function(a, i) {
        var tr = document.createElement('tr');
        var link = a.naverLink || a.originalLink;

        tr.innerHTML =
          '<td class="col-check"><input type="checkbox" class="article-cb" value="' + i + '" checked onchange="updateArticleCount()" /></td>' +
          '<td class="col-idx">' + (i + 1) + '</td>' +
          '<td class="col-title"><a href="' + escapeHtml(link) + '" target="_blank" rel="noopener">' + escapeHtml(a.title) + '</a></td>' +
          '<td class="col-press">' + escapeHtml(a.press) + '</td>' +
          '<td class="col-date">' + escapeHtml(a.date) + '</td>';

        tbody.appendChild(tr);
      });

      document.getElementById('headerCheckbox').checked = true;
      updateArticleCount();
    }

    function selectAllArticles() {
      document.querySelectorAll('.article-cb').forEach(function(cb) { cb.checked = true; });
      document.getElementById('headerCheckbox').checked = true;
      updateArticleCount();
    }

    function deselectAllArticles() {
      document.querySelectorAll('.article-cb').forEach(function(cb) { cb.checked = false; });
      document.getElementById('headerCheckbox').checked = false;
      updateArticleCount();
    }

    function toggleAllArticles(header) {
      document.querySelectorAll('.article-cb').forEach(function(cb) { cb.checked = header.checked; });
      updateArticleCount();
    }

    async function startProcessing() {
      var selected = [];
      document.querySelectorAll('.article-cb:checked').forEach(function(cb) {
        selected.push(parseInt(cb.value, 10));
      });

      if (selected.length === 0) {
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
          body: JSON.stringify({ sessionId: currentSessionId, selected: selected })
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

      eventSource.onmessage = function(e) {
        var data;
        try { data = JSON.parse(e.data); } catch { return; }

        if (data.type === 'progress') {
          var pct = Math.round((data.step / data.totalSteps) * 100);
          document.getElementById('progressBar').style.width = pct + '%';
          document.getElementById('stepLabel').innerHTML =
            '<span class="spinner"></span>' + escapeHtml(data.step + '/' + data.totalSteps + ' ' + data.message);
        }

        if (data.type === 'log') {
          appendLog(data.level, data.message, data.timestamp);
        }

        if (data.type === 'done') {
          if (eventSource) { eventSource.close(); eventSource = null; }
          document.getElementById('progressBar').style.width = '100%';
          document.getElementById('stepLabel').textContent = '완료!';
          showComplete(data.filename);
        }

        if (data.type === 'error') {
          if (eventSource) { eventSource.close(); eventSource = null; }
          appendLog('error', data.message, new Date().toISOString());
          document.getElementById('stepLabel').textContent = '오류 발생';
          document.getElementById('progressBar').style.width = '0%';
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
    function showComplete(filename) {
      document.getElementById('completeDetail').textContent = filename;
      document.getElementById('downloadBtn').href = '/api/download/' + encodeURIComponent(filename);
      showSection('sectionComplete');
    }

    function resetApp() {
      currentSessionId = null;
      currentArticles = [];
      if (eventSource) { eventSource.close(); eventSource = null; }
      document.getElementById('keyword').value = '';
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
        if (data.needsSetup) {
          // Pre-fill existing values
          if (data.current.CLAUDE_MODEL) document.getElementById('setupClaudeModel').value = data.current.CLAUDE_MODEL;
          if (data.current.NAVER_CLIENT_ID) document.getElementById('setupNaverId').value = data.current.NAVER_CLIENT_ID;
          if (data.current.NAVER_CLIENT_SECRET) document.getElementById('setupNaverSecret').value = data.current.NAVER_CLIENT_SECRET;
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
    res.json({
      needsSetup: !isSetupComplete(),
      current: {
        CLAUDE_MODEL: process.env.CLAUDE_MODEL || "",
        NAVER_CLIENT_ID: process.env.NAVER_CLIENT_ID || "",
        NAVER_CLIENT_SECRET: process.env.NAVER_CLIENT_SECRET || "",
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

      const lines: string[] = [];
      if (body.ANTHROPIC_API_KEY) lines.push(`ANTHROPIC_API_KEY=${body.ANTHROPIC_API_KEY}`);
      if (body.CLAUDE_MODEL) lines.push(`CLAUDE_MODEL=${body.CLAUDE_MODEL}`);
      if (body.NAVER_CLIENT_ID) lines.push(`NAVER_CLIENT_ID=${body.NAVER_CLIENT_ID}`);
      if (body.NAVER_CLIENT_SECRET) lines.push(`NAVER_CLIENT_SECRET=${body.NAVER_CLIENT_SECRET}`);

      fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");

      // 환경변수 즉시 반영
      if (body.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = body.ANTHROPIC_API_KEY;
      if (body.CLAUDE_MODEL) process.env.CLAUDE_MODEL = body.CLAUDE_MODEL;
      if (body.NAVER_CLIENT_ID) process.env.NAVER_CLIENT_ID = body.NAVER_CLIENT_ID;
      if (body.NAVER_CLIENT_SECRET) process.env.NAVER_CLIENT_SECRET = body.NAVER_CLIENT_SECRET;

      logger.info("설정이 저장되었습니다.");
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "설정 저장 실패";
      logger.error("설정 저장 오류: " + msg, err);
      res.status(500).json({ error: msg });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/search
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
      const { keyword, days, method } = req.body as {
        keyword: unknown;
        days: unknown;
        method: unknown;
      };

      if (!keyword || typeof keyword !== "string" || keyword.trim().length === 0) {
        unsubscribe();
        res.status(400).json({ error: "키워드를 입력해주세요." });
        return;
      }

      const parsedDays =
        typeof days === "number" && days >= 1 ? Math.floor(days) : 7;

      const searchMethod: SearchMethod =
        method === "api" ? "api" : method === "scraping" ? "scraping" : "auto";

      logger.info(`검색 요청: "${keyword}" (최근 ${parsedDays}일, 방법: ${searchMethod})`);

      const articles = await scrapeNaverNews(keyword.trim(), parsedDays, searchMethod);

      const sessionId = crypto.randomUUID();
      const session: SessionData = {
        keyword: keyword.trim(),
        days: parsedDays,
        articles,
        status: "searched",
        sseClients: new Set(),
        logs: [],
      };
      sessions.set(sessionId, session);
      sessionCreatedAt.set(sessionId, Date.now());

      logger.info(
        `검색 완료: "${keyword}" — ${articles.length}건 (세션: ${sessionId})`,
      );

      unsubscribe();

      res.json({
        sessionId,
        articles,
        count: articles.length,
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
  // POST /api/process
  // -------------------------------------------------------------------------
  app.post("/api/process", (req, res) => {
    try {
      const { sessionId, selected } = req.body as {
        sessionId: unknown;
        selected: unknown;
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

      if (!Array.isArray(selected)) {
        res.status(400).json({ error: "선택된 기사 목록이 필요합니다." });
        return;
      }

      const validIndices = (selected as unknown[]).filter(
        (i): i is number =>
          typeof i === "number" &&
          Number.isInteger(i) &&
          i >= 0 &&
          i < session.articles.length,
      );

      if (validIndices.length === 0) {
        res.status(400).json({ error: "유효한 기사가 선택되지 않았습니다." });
        return;
      }

      session.selectedArticles = validIndices.map((i) => session.articles[i]);
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
  const totalSteps = 4;
  const selectedArticles = session.selectedArticles!;
  const keyword = session.keyword;

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
      );

      // Step 2: Rank by importance
      sessionProgress(
        session,
        2,
        totalSteps,
        "M&A 중요도 분석 중...",
      );
      const rankedArticles = await rankByImportance(
        articleDetails,
        claude,
        claudeModel,
      );

      // Step 3: Generate executive summary
      sessionProgress(
        session,
        3,
        totalSteps,
        "Executive Summary 생성 중...",
      );
      const executiveSummary = await generateExecutiveSummary(
        rankedArticles,
        keyword,
        claude,
        claudeModel,
      );

      // Step 4: Generate DOCX
      sessionProgress(session, 4, totalSteps, "DOCX 리포트 생성 중...");

      const outputDir = ensureOutputDir();
      const dateStr = getDateStr();
      const outputFilename = `뉴스클리핑_${keyword}_${dateStr}.docx`;
      const outputPath = path.join(outputDir, outputFilename);

      const config: ClipperConfig = {
        keyword,
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

      // Done
      session.status = "done";
      session.outputPath = outputPath;

      sessionLog(session, "info", `리포트 생성 완료: ${outputFilename}`);
      broadcastSSE(session, { type: "done", filename: outputFilename });
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
