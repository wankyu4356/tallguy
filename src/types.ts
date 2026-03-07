export interface ClipperConfig {
  keyword: string;
  days: number;
  outputPath: string;
  claudeModel: string;
  port: number;
}

export interface SearchArticle {
  title: string;
  originalLink: string;
  naverLink: string | null;
  press: string;
  date: string;
  summary: string;
}

export interface ArticleDetail {
  title: string;
  publishDate: string;
  reporter: string;
  press: string;
  body: string;
  link: string;
}

export interface RankedArticle extends ArticleDetail {
  importance: number;
  importanceReason: string;
}

export interface ClipperReport {
  config: ClipperConfig;
  executiveSummary: string[];
  articles: RankedArticle[];
  generatedAt: string;
  analysisPrompt?: string;
}
