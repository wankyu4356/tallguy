import express from "express";
import open from "open";
import type { SearchArticle } from "./types.js";

const TIMEOUT_MS = 30 * 60 * 1000; // 30분

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildHtml(articles: SearchArticle[], keyword: string): string {
  const rows = articles
    .map(
      (a, i) => `
      <tr>
        <td class="check-col">
          <input type="checkbox" name="selected" value="${i}" checked />
        </td>
        <td class="idx-col">${i + 1}</td>
        <td class="title-col">
          <a href="${escapeHtml(a.naverLink || a.originalLink)}" target="_blank" rel="noopener">
            ${escapeHtml(a.title)}
          </a>
        </td>
        <td class="press-col">${escapeHtml(a.press)}</td>
        <td class="date-col">${escapeHtml(a.date)}</td>
      </tr>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>뉴스 클리핑 - 기사 선택</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5; color: #333; padding: 20px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { font-size: 24px; margin-bottom: 8px; color: #1a1a1a; }
    .subtitle { color: #666; margin-bottom: 20px; font-size: 14px; }
    .controls {
      display: flex; gap: 12px; margin-bottom: 16px; align-items: center;
      flex-wrap: wrap;
    }
    .controls button {
      padding: 8px 16px; border: 1px solid #ddd; border-radius: 6px;
      background: white; cursor: pointer; font-size: 13px; transition: all 0.2s;
    }
    .controls button:hover { background: #f0f0f0; border-color: #bbb; }
    .controls button.primary {
      background: #03c75a; color: white; border-color: #03c75a;
      font-weight: 600; font-size: 15px; padding: 10px 32px;
    }
    .controls button.primary:hover { background: #02b350; }
    .count { margin-left: auto; font-size: 14px; color: #666; }
    table {
      width: 100%; border-collapse: collapse; background: white;
      border-radius: 8px; overflow: hidden;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    thead { background: #fafafa; }
    th {
      padding: 12px 16px; text-align: left; font-size: 13px;
      color: #666; border-bottom: 2px solid #eee; font-weight: 600;
    }
    td { padding: 10px 16px; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
    tr:hover { background: #fafffe; }
    .check-col { width: 40px; text-align: center; }
    .idx-col { width: 50px; text-align: center; color: #999; }
    .title-col a { color: #1a0dab; text-decoration: none; line-height: 1.4; }
    .title-col a:hover { text-decoration: underline; }
    .title-col a:visited { color: #681da8; }
    .press-col { width: 120px; color: #555; white-space: nowrap; }
    .date-col { width: 100px; color: #999; white-space: nowrap; }
    input[type="checkbox"] { width: 18px; height: 18px; cursor: pointer; accent-color: #03c75a; }
    .done-msg {
      display: none; text-align: center; padding: 60px 20px;
      font-size: 18px; color: #03c75a;
    }
    .done-msg.show { display: block; }
    .info-bar {
      background: #e8f5e9; border-radius: 8px; padding: 12px 16px;
      margin-bottom: 16px; font-size: 14px; color: #2e7d32;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📰 뉴스 클리핑 - 기사 선택</h1>
    <p class="subtitle">키워드: <strong>"${escapeHtml(keyword)}"</strong> | 총 ${articles.length}건</p>

    <div class="info-bar">
      클리핑할 기사를 선택하세요. 제목을 클릭하면 원문을 확인할 수 있습니다. 선택 완료 후 "선택 완료" 버튼을 눌러주세요.
    </div>

    <form id="articleForm">
      <div class="controls">
        <button type="button" onclick="selectAll()">전체 선택</button>
        <button type="button" onclick="deselectAll()">전체 해제</button>
        <button type="submit" class="primary">✅ 선택 완료</button>
        <span class="count" id="countDisplay">선택: ${articles.length} / ${articles.length}</span>
      </div>

      <table>
        <thead>
          <tr>
            <th class="check-col"><input type="checkbox" id="headerCheck" checked onchange="toggleAll(this)" /></th>
            <th class="idx-col">#</th>
            <th>기사 제목</th>
            <th class="press-col">언론사</th>
            <th class="date-col">날짜</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </form>

    <div class="done-msg" id="doneMsg">
      ✅ 선택이 완료되었습니다. 기사 본문을 가져오는 중입니다...<br/>
      이 탭을 닫아도 됩니다.
    </div>
  </div>

  <script>
    const form = document.getElementById('articleForm');
    const checkboxes = () => document.querySelectorAll('input[name="selected"]');
    const countDisplay = document.getElementById('countDisplay');
    const total = ${articles.length};

    function updateCount() {
      const checked = document.querySelectorAll('input[name="selected"]:checked').length;
      countDisplay.textContent = '선택: ' + checked + ' / ' + total;
    }

    document.querySelectorAll('input[name="selected"]').forEach(cb => {
      cb.addEventListener('change', updateCount);
    });

    function selectAll() {
      checkboxes().forEach(cb => cb.checked = true);
      document.getElementById('headerCheck').checked = true;
      updateCount();
    }

    function deselectAll() {
      checkboxes().forEach(cb => cb.checked = false);
      document.getElementById('headerCheck').checked = false;
      updateCount();
    }

    function toggleAll(header) {
      checkboxes().forEach(cb => cb.checked = header.checked);
      updateCount();
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const selected = [];
      checkboxes().forEach(cb => { if (cb.checked) selected.push(parseInt(cb.value)); });

      if (selected.length === 0) {
        alert('최소 1개 이상의 기사를 선택해주세요.');
        return;
      }

      try {
        const res = await fetch('/api/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ selected }),
        });

        if (res.ok) {
          form.style.display = 'none';
          document.getElementById('doneMsg').classList.add('show');
        }
      } catch (err) {
        alert('오류가 발생했습니다: ' + err.message);
      }
    });
  </script>
</body>
</html>`;
}

export function startSelectionServer(
  articles: SearchArticle[],
  keyword: string,
  port: number,
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());

    let resolved = false; // Issue 3: 중복 제출 방지

    app.get("/", (_req, res) => {
      res.type("html").send(buildHtml(articles, keyword));
    });

    app.post("/api/select", (req, res) => {
      // Issue 3: 이미 처리된 경우 무시
      if (resolved) {
        res.status(409).json({ error: "이미 선택이 완료되었습니다." });
        return;
      }

      const { selected } = req.body as { selected: unknown };

      // Issue 5: 입력 검증
      if (!Array.isArray(selected)) {
        res.status(400).json({ error: "잘못된 요청입니다." });
        return;
      }

      const validIndices = selected.filter(
        (i): i is number =>
          typeof i === "number" && Number.isInteger(i) && i >= 0 && i < articles.length,
      );

      if (validIndices.length === 0) {
        res.status(400).json({ error: "유효한 기사가 선택되지 않았습니다." });
        return;
      }

      resolved = true;
      res.json({ ok: true, count: validIndices.length });

      setTimeout(() => {
        clearTimeout(timeout);
        server.close();
        resolve(validIndices);
      }, 300);
    });

    // Issue 2: 타임아웃 (30분)
    const timeout = setTimeout(() => {
      if (!resolved) {
        console.log("\n   ⏰ 선택 대기 시간이 초과되었습니다 (30분).");
        console.log("   프로그램을 종료합니다. 다시 실행해주세요.\n");
        server.close();
        reject(new Error("기사 선택 타임아웃 (30분 초과)"));
      }
    }, TIMEOUT_MS);

    const server = app.listen(port, () => {
      const url = `http://localhost:${port}`;
      console.log(`📋 기사 선택 페이지가 열렸습니다: ${url}`);
      console.log("   브라우저에서 기사를 선택한 후 '선택 완료' 버튼을 눌러주세요.\n");
      open(url).catch(() => {
        console.log("   ⚠️  브라우저를 자동으로 열 수 없습니다. 위 URL을 직접 열어주세요.");
      });
    });

    // Issue 1: 포트 충돌 처리
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        const nextPort = port + 1;
        console.log(`   ⚠️  포트 ${port}이 사용 중입니다. 포트 ${nextPort}으로 재시도합니다.`);
        clearTimeout(timeout);
        resolve(startSelectionServer(articles, keyword, nextPort));
      } else {
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}
