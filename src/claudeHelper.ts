import type Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger.js";

/**
 * 설정된 모델이 폐기/오타 등으로 404를 반환하면 최신 모델로 자동 폴백한다.
 * 한 번 폴백에 성공하면 이후 호출은 바로 그 모델을 사용한다.
 */
const FALLBACK_MODELS = ["claude-sonnet-5", "claude-haiku-4-5-20251001"];

let resolvedModel: string | null = null;

function isModelNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("not_found_error") && msg.includes("model");
}

export interface ClaudeCreateParams {
  model: string;
  max_tokens: number;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

export async function claudeCreate(
  claude: Anthropic,
  params: ClaudeCreateParams,
): Promise<Anthropic.Message> {
  const primary = resolvedModel || params.model;
  const candidates = [primary, ...FALLBACK_MODELS.filter((m) => m !== primary)];

  let lastErr: unknown = null;
  for (let i = 0; i < candidates.length; i++) {
    try {
      const response = await claude.messages.create({ ...params, model: candidates[i] });
      if (candidates[i] !== params.model) {
        resolvedModel = candidates[i];
      }
      return response as Anthropic.Message;
    } catch (err) {
      lastErr = err;
      if (isModelNotFound(err) && i < candidates.length - 1) {
        logger.warn(
          `모델 "${candidates[i]}"를 사용할 수 없습니다 (404) → "${candidates[i + 1]}"(으)로 자동 대체합니다. ` +
          `.env의 CLAUDE_MODEL을 업데이트하세요.`,
        );
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
