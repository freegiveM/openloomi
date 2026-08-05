/**
 * Evaluation metrics for CL-bench benchmark.
 *
 * Includes rubric evaluation with GPT-5.1 judge, BLEU, F1 score.
 */

import { RUBRIC_EVALUATION_PROMPT } from "./prompts";
import type { RubricResult } from "./types";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Calculate F1 score between prediction and ground truth.
 */
export function calculateF1Score(
  prediction: string,
  groundTruth: string,
): number {
  if (!prediction || !groundTruth) {
    return 0.0;
  }

  const predTokens = new Set(prediction.toLowerCase().split(/\s+/));
  const gtTokens = new Set(String(groundTruth).toLowerCase().split(/\s+/));

  if (predTokens.size === 0 || gtTokens.size === 0) {
    return 0.0;
  }

  const commonTokens = new Set([...predTokens].filter((x) => gtTokens.has(x)));
  const precision = commonTokens.size / predTokens.size;
  const recall = commonTokens.size / gtTokens.size;

  if (precision + recall === 0) {
    return 0.0;
  }

  const f1 = (2 * precision * recall) / (precision + recall);
  return f1;
}

/**
 * Calculate BLEU scores between prediction and ground truth.
 */
export function calculateBLEUScores(
  prediction: string,
  groundTruth: string,
): { bleu1: number; bleu2: number; bleu3: number; bleu4: number } {
  if (!prediction || !groundTruth) {
    return { bleu1: 0.0, bleu2: 0.0, bleu3: 0.0, bleu4: 0.0 };
  }

  const predTokens = prediction
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const gtTokens = String(groundTruth)
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (predTokens.length === 0 || gtTokens.length === 0) {
    return { bleu1: 0.0, bleu2: 0.0, bleu3: 0.0, bleu4: 0.0 };
  }

  const getNgrams = (tokens: string[], n: number): Set<string> => {
    const ngrams = new Set<string>();
    for (let i = 0; i <= tokens.length - n; i++) {
      ngrams.add(tokens.slice(i, i + n).join(" "));
    }
    return ngrams;
  };

  const getPrecision = (
    predTokens: string[],
    gtTokens: string[],
    n: number,
  ): number => {
    if (predTokens.length < n) return 0;

    const predNgrams = getNgrams(predTokens, n);
    const gtNgrams = getNgrams(gtTokens, n);

    if (predNgrams.size === 0) return 0;

    let matches = 0;
    for (const ngram of predNgrams) {
      if (gtNgrams.has(ngram)) {
        matches++;
      }
    }

    return matches / predNgrams.size;
  };

  const bleu1 = getPrecision(predTokens, gtTokens, 1);
  const bleu2 = getPrecision(predTokens, gtTokens, 2);
  const bleu3 = getPrecision(predTokens, gtTokens, 3);
  const bleu4 = getPrecision(predTokens, gtTokens, 4);

  const brevityPenalty = Math.min(
    1.0,
    Math.exp(1 - gtTokens.length / Math.max(predTokens.length, 1)),
  );

  return {
    bleu1: bleu1 * brevityPenalty,
    bleu2: bleu2 * brevityPenalty,
    bleu3: bleu3 * brevityPenalty,
    bleu4: bleu4 * brevityPenalty,
  };
}

/**
 * Calculate all metrics between prediction and ground truth.
 */
export function calculateMetrics(
  prediction: string,
  groundTruth: string,
): {
  f1: number;
  bleu1: number;
  bleu2: number;
  bleu3: number;
  bleu4: number;
} {
  const f1 = calculateF1Score(prediction, groundTruth);
  const bleuScores = calculateBLEUScores(prediction, groundTruth);

  return {
    f1,
    ...bleuScores,
  };
}

interface RubricJudgeResult {
  passed?: boolean;
  reasoning?: string;
}

/**
 * Extract the first balanced {...} JSON object from a free-form string.
 * Handles nested objects, strings with embedded braces, and escapes correctly.
 *
 * This replaces the naive greedy regex /\{[\s\S]*\}/ which would over-match
 * across multiple objects or fail when the JSON was wrapped in markdown
 * code fences, causing spurious "Could not parse JSON" fallbacks.
 */
function extractFirstBalancedJson(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") {
      if (start === -1) start = i;
      depth++;
    } else if (ch === "}") {
      if (start !== -1) {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
  }
  return null;
}

/**
 * Evaluate rubrics using GPT-5.1 judge via OpenRouter.
 */
export async function evaluateRubrics(
  taskId: string,
  messages: Array<{ role: string; content: string }>,
  rubrics: string[],
  response: string,
  reasoningEffort: "low" | "high" = "low",
  maxRetries = 3,
): Promise<RubricResult[]> {
  const results: RubricResult[] = [];

  for (const rubric of rubrics) {
    const prompt = RUBRIC_EVALUATION_PROMPT.replace("{rubric}", rubric).replace(
      "{response}",
      response,
    );

    let lastError: Error | undefined;
    let passed = false;
    let reasoning = "";

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Use direct fetch to call OpenRouter API
        const fetchResponse = await fetch(OPENROUTER_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          },
          body: JSON.stringify({
            model: "qwen/qwen3.7-plus",
            messages: [
              {
                role: "user",
                content: prompt,
              },
            ],
            max_tokens: 1000,
          }),
          signal: AbortSignal.timeout(60000),
        });

        if (!fetchResponse.ok) {
          throw new Error(`OpenRouter API error: ${fetchResponse.status}`);
        }

        const data = (await fetchResponse.json()) as {
          choices?: Array<{
            message?: { content?: string; reasoning?: string };
          }>;
        };
        const text =
          data.choices?.[0]?.message?.content ||
          data.choices?.[0]?.message?.reasoning ||
          "";

        // Try to extract the first balanced JSON object from the response.
        // This handles markdown code fences (```json ... ```) and nested
        // objects correctly, unlike the previous greedy /\{[\s\S]*\}/.
        const balanced = extractFirstBalancedJson(text);
        if (!balanced) {
          // No balanced JSON object found in the response.
          throw new Error(
            `[Rubric] No JSON object found in judge response: ${text.slice(0, 100)}`,
          );
        }

        // Parse JSON response
        let result: RubricJudgeResult;
        try {
          result = JSON.parse(balanced);
        } catch (parseError) {
          throw new Error(
            `[Rubric] JSON parse failed: ${parseError instanceof Error ? parseError.message : String(parseError)}. Raw: ${balanced.slice(0, 100)}`,
          );
        }

        passed = result.passed ?? false;
        reasoning = result.reasoning ?? "";

        // Only count as success if we got BOTH fields
        if (result.passed !== undefined && result.reasoning !== undefined) {
          break;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.log(
          `[Rubric] Attempt ${attempt}/${maxRetries} failed: ${lastError.message.substring(0, 80)}`,
        );
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    if (lastError && !reasoning) {
      console.warn(
        `[Rubric] All attempts failed for rubric: ${rubric.substring(0, 50)}...`,
      );
      reasoning = `Evaluation failed: ${lastError.message}`;
      // Mark as failed to avoid contaminating statistics; do NOT silently
      // fall back to passed=false here — the caller treats `passed` as a
      // definitive judgement, so we leave it as initialized false only when
      // every retry truly failed to return any signal.
    }

    results.push({
      rubric,
      passed,
      reasoning,
    });

    console.log(
      `[${taskId}] Rubric: ${passed ? "✓" : "✗"} "${rubric.substring(0, 60)}..."`,
    );
  }

  return results;
}

/**
 * Calculate task pass rate - returns true only if ALL rubrics pass.
 */
export function calculateTaskPassRate(rubricResults: RubricResult[]): boolean {
  if (rubricResults.length === 0) {
    return false;
  }
  return rubricResults.every((r) => r.passed);
}

/**
 * Calculate metrics for a category of results.
 */
export function calculateCategoryMetrics(
  results: Array<{
    llm_score?: number;
    f1_score?: number;
    bleu_score?: number;
    bleu4?: number;
    all_rubrics_passed?: boolean;
  }>,
): {
  count: number;
  rubric_pass_rate: number;
  llm_judge_accuracy: number;
  f1_mean: number;
  bleu1_mean: number;
  bleu4_mean: number;
} {
  if (results.length === 0) {
    return {
      count: 0,
      rubric_pass_rate: 0.0,
      llm_judge_accuracy: 0.0,
      f1_mean: 0.0,
      bleu1_mean: 0.0,
      bleu4_mean: 0.0,
    };
  }

  const rubricPassCount = results.filter((r) => r.all_rubrics_passed).length;
  const llmScores = results.map((r) => r.llm_score ?? 0);
  const f1Scores = results.map((r) => r.f1_score ?? 0);
  const bleu1Scores = results.map((r) => r.bleu_score ?? 0);
  const bleu4Scores = results.map((r) => r.bleu4 ?? r.bleu_score ?? 0);

  const mean = (arr: number[]): number =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  return {
    count: results.length,
    rubric_pass_rate: rubricPassCount / results.length,
    llm_judge_accuracy: mean(llmScores),
    f1_mean: mean(f1Scores),
    bleu1_mean: mean(bleu1Scores),
    bleu4_mean: mean(bleu4Scores),
  };
}
