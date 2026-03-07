import dotenv from "dotenv";

dotenv.config();

export function getConfig() {
  const port = parseInt(process.env.PORT || "3000", 10);
  const claudeModel = process.env.CLAUDE_MODEL || "claude-opus-4-6";

  return { port, claudeModel };
}

export function isSetupComplete(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
