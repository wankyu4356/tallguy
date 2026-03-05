import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  ExternalHyperlink,
  PageBreak,
} from "docx";
import fs from "fs";
import type { ClipperReport } from "./types.js";

function createTitlePage(report: ClipperReport): Paragraph[] {
  const today = new Date();
  const dateStr = `${today.getFullYear()}년 ${today.getMonth() + 1}월 ${today.getDate()}일`;

  return [
    new Paragraph({ spacing: { before: 3000 } }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({
          text: "뉴스 클리핑 리포트",
          bold: true,
          size: 56,
          font: "맑은 고딕",
          color: "1B3A5C",
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [
        new TextRun({
          text: `키워드: "${report.config.keyword}"`,
          size: 28,
          font: "맑은 고딕",
          color: "555555",
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [
        new TextRun({
          text: `검색 기간: 최근 ${report.config.days}일`,
          size: 24,
          font: "맑은 고딕",
          color: "777777",
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [
        new TextRun({
          text: `생성일: ${dateStr}`,
          size: 24,
          font: "맑은 고딕",
          color: "777777",
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: `총 ${report.articles.length}건의 기사 분석`,
          size: 22,
          font: "맑은 고딕",
          color: "999999",
        }),
      ],
    }),
  ];
}

function createExecutiveSummary(bullets: string[]): Paragraph[] {
  const paragraphs: Paragraph[] = [
    new Paragraph({
      children: [new PageBreak()],
    }),
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 300 },
      children: [
        new TextRun({
          text: "Executive Summary",
          bold: true,
          size: 36,
          font: "맑은 고딕",
          color: "1B3A5C",
        }),
      ],
    }),
  ];

  for (const bullet of bullets) {
    paragraphs.push(
      new Paragraph({
        spacing: { after: 120 },
        indent: { left: 360 },
        bullet: { level: 0 },
        children: [
          new TextRun({
            text: bullet,
            size: 22,
            font: "맑은 고딕",
          }),
        ],
      }),
    );
  }

  return paragraphs;
}

function createArticleSection(report: ClipperReport): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const importanceLabel = report.analysisPrompt
    ? "중요도"
    : "중요도";

  for (let i = 0; i < report.articles.length; i++) {
    const article = report.articles[i];

    // 기사 시작 전 항상 페이지 나눔
    paragraphs.push(
      new Paragraph({ children: [new PageBreak()] }),
    );

    // 기사 번호 및 제목
    paragraphs.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { after: 100 },
        children: [
          new TextRun({
            text: `${i + 1}. ${article.title}`,
            bold: true,
            size: 26,
            font: "맑은 고딕",
            color: "2C3E50",
          }),
        ],
      }),
    );

    // 메타 정보
    paragraphs.push(
      new Paragraph({
        spacing: { after: 60 },
        children: [
          new TextRun({ text: "언론사: ", bold: true, size: 20, font: "맑은 고딕", color: "666666" }),
          new TextRun({ text: article.press, size: 20, font: "맑은 고딕" }),
          new TextRun({ text: "  |  발행일: ", bold: true, size: 20, font: "맑은 고딕", color: "666666" }),
          new TextRun({ text: article.publishDate, size: 20, font: "맑은 고딕" }),
          new TextRun({ text: "  |  기자: ", bold: true, size: 20, font: "맑은 고딕", color: "666666" }),
          new TextRun({ text: article.reporter, size: 20, font: "맑은 고딕" }),
        ],
      }),
    );

    // 중요도
    paragraphs.push(
      new Paragraph({
        spacing: { after: 60 },
        children: [
          new TextRun({
            text: `${importanceLabel}: ${article.importance}위`,
            bold: true,
            size: 20,
            font: "맑은 고딕",
            color: "E74C3C",
          }),
          new TextRun({
            text: ` — ${article.importanceReason}`,
            size: 20,
            font: "맑은 고딕",
            color: "888888",
          }),
        ],
      }),
    );

    // 링크
    paragraphs.push(
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({ text: "원문: ", bold: true, size: 20, font: "맑은 고딕", color: "666666" }),
          new ExternalHyperlink({
            children: [
              new TextRun({
                text: article.link,
                size: 18,
                font: "맑은 고딕",
                color: "2980B9",
                underline: {},
              }),
            ],
            link: article.link,
          }),
        ],
      }),
    );

    // 본문 — 문단 나누기 + 가독성 향상
    const bodyParagraphs = article.body.split(/\n\n+/).filter((p) => p.trim());
    for (const bodyPara of bodyParagraphs) {
      // 문단 내 줄바꿈 처리
      const lines = bodyPara.split("\n").filter((l) => l.trim());
      const runs: TextRun[] = [];
      for (let j = 0; j < lines.length; j++) {
        if (j > 0) {
          runs.push(new TextRun({ text: "", break: 1 }));
        }
        runs.push(new TextRun({
          text: lines[j].trim(),
          size: 21,
          font: "맑은 고딕",
        }));
      }

      paragraphs.push(
        new Paragraph({
          spacing: { after: 160, line: 360 },
          indent: { firstLine: 200 },
          children: runs,
        }),
      );
    }
  }

  return paragraphs;
}

export async function generateDocx(report: ClipperReport): Promise<string> {
  console.log("📄 DOCX 파일 생성 중...");

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: "맑은 고딕",
            size: 22,
          },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440,
              right: 1440,
              bottom: 1440,
              left: 1440,
            },
          },
        },
        children: [
          ...createTitlePage(report),
          ...createExecutiveSummary(report.executiveSummary),
          ...createArticleSection(report),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(report.config.outputPath, buffer);

  console.log(`   ✅ 파일 저장 완료: ${report.config.outputPath}\n`);
  return report.config.outputPath;
}
