import dotenv from "dotenv";

dotenv.config();

export function getConfig() {
  const port = parseInt(process.env.PORT || "3000", 10);
  const claudeModel = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";

  return { port, claudeModel };
}

export function isSetupComplete(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
