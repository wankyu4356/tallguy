import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  ExternalHyperlink,
  TableOfContents,
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

function createSeparator(): Paragraph {
  return new Paragraph({
    spacing: { before: 200, after: 200 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
    },
    children: [],
  });
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
  const paragraphs: Paragraph[] = [
    new Paragraph({
      children: [new PageBreak()],
    }),
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 400 },
      children: [
        new TextRun({
          text: "기사 상세",
          bold: true,
          size: 36,
          font: "맑은 고딕",
          color: "1B3A5C",
        }),
      ],
    }),
  ];

  for (let i = 0; i < report.articles.length; i++) {
    const article = report.articles[i];

    // 기사 번호 및 제목
    paragraphs.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 100 },
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
            text: `M&A 중요도: ${article.importance}위`,
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
        spacing: { after: 150 },
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

    // 본문
    const bodyParagraphs = article.body.split("\n").filter((line) => line.trim());
    for (const bodyPara of bodyParagraphs) {
      paragraphs.push(
        new Paragraph({
          spacing: { after: 80 },
          children: [
            new TextRun({
              text: bodyPara.trim(),
              size: 21,
              font: "맑은 고딕",
            }),
          ],
        }),
      );
    }

    // 구분선 (마지막 기사 제외)
    if (i < report.articles.length - 1) {
      paragraphs.push(createSeparator());
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
