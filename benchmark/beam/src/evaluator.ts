/**
 * BEAM Evaluator for OpenLoomi memory system.
 *
 * Differences from the LongMemEval evaluator:
 *   - Conversations can be enormous (1M avg 842 turns, 10M avg 7,757 turns).
 *     We chunk by `CHUNK_TURNS` and write one `.md` per chunk to
 *     `~/.openloomi/data/memory/bench/beam_{entry_id}/`.
 *   - We also write a `chunk_{i}_index.md` index so the agent can find
 *     a specific time range without reading every file.
 *   - Each chunk ships with its timestamp range in the file header so
 *     date-aware questions don't need to grep.
 *   - 10M bucket warning: 3,880+ files → we inject "USE FILE SEARCH" into
 *     the agent prompt when the conversation has > 50 chunks.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import type { MemoryRecord } from "./contracts";

import type {
  BeamConversation,
  BeamProbingQuestion,
  BeamTurn,
  EvaluationResult,
  Prediction,
} from "./types";
import {
  InMemoryStorageAdapter,
  callAgentApi,
  readAuthToken,
  findAvailablePort,
  DEFAULT_PORTS,
} from "./memory-adapter";
import {
  evaluateNuggetJudge,
  summarizeNuggetScores,
  looksLikeAbstention,
  type NuggetJudgeResult,
} from "./metrics";

/**
 * How many turns go into a single chunk file.
 *
 * 20 ≈ 1 LongMemEval session, which matches the granularity of the
 * agent prompt that says "Read ALL .md files". Smaller chunks explode
 * the file count for the 10M bucket; larger chunks blow past context.
 */
export const CHUNK_TURNS = 20;

/**
 * Above this many chunks per conversation we tell the agent to search
 * the index instead of trying to read every file.
 */
export const LARGE_CONVERSATION_CHUNK_THRESHOLD = 50;

function parseTimestampMs(ts: string | undefined): number | undefined {
  if (!ts) return undefined;
  try {
    const ms = new Date(ts).getTime();
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

function formatTimestamp(ts: string | undefined): string {
  if (!ts) return "(unknown)";
  try {
    return new Date(ts).toISOString();
  } catch {
    return ts;
  }
}

function buildChunkText(
  conv: BeamConversation,
  chunkIndex: number,
  startTurn: number,
  endTurn: number,
  turns: BeamTurn[],
): string {
  const header =
    `# ${conv.entry_id} — chunk ${chunkIndex}\n` +
    `# Turns ${startTurn}..${endTurn} of ${conv.chat.length}\n` +
    `# Scale: ${conv.scale}\n` +
    `# First turn: ${formatTimestamp(turns[0]?.timestamp)}\n` +
    `# Last turn:  ${formatTimestamp(turns[turns.length - 1]?.timestamp)}\n\n`;

  const body = turns
    .map((turn, i) => {
      const ts = turn.timestamp ? ` (${turn.timestamp})` : "";
      return `**${turn.speaker}${ts}:** ${turn.text}`;
    })
    .join("\n\n");

  return `${header}${body}\n`;
}

function buildChunkIndex(
  conv: BeamConversation,
  chunks: Array<{
    index: number;
    startTurn: number;
    endTurn: number;
    firstTs: string | undefined;
    lastTs: string | undefined;
  }>,
): string {
  const lines: string[] = [
    `# ${conv.entry_id} — chunk index`,
    `# Scale: ${conv.scale}`,
    `# Total turns: ${conv.chat.length}`,
    `# Total chunks: ${chunks.length}`,
    "",
    "| Chunk | Turns | First timestamp | Last timestamp |",
    "|------:|------:|-----------------|----------------|",
  ];
  for (const c of chunks) {
    lines.push(
      `| ${c.index} | ${c.startTurn}..${c.endTurn} | ${formatTimestamp(c.firstTs)} | ${formatTimestamp(c.lastTs)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Write the chunked conversation to disk and return the in-memory records.
 */
async function writeConversationChunks(
  conv: BeamConversation,
): Promise<MemoryRecord[]> {
  const memoryDir = join(
    homedir(),
    ".openloomi",
    "data",
    "memory",
    "bench",
    `beam_${conv.entry_id}`,
  );

  await mkdir(memoryDir, { recursive: true });

  const records: MemoryRecord[] = [];
  const chunkSummaries: Array<{
    index: number;
    startTurn: number;
    endTurn: number;
    firstTs: string | undefined;
    lastTs: string | undefined;
  }> = [];

  let chunkIndex = 0;
  for (let i = 0; i < conv.chat.length; i += CHUNK_TURNS) {
    const slice = conv.chat.slice(i, i + CHUNK_TURNS);
    const startTurn = i;
    const endTurn = i + slice.length - 1;

    const filename = `chunk_${chunkIndex}.md`;
    const filepath = join(memoryDir, filename);
    const text = buildChunkText(conv, chunkIndex, startTurn, endTurn, slice);

    await writeFile(filepath, text, "utf-8");

    const firstTs = slice[0]?.timestamp;
    const lastTs = slice[slice.length - 1]?.timestamp;
    chunkSummaries.push({
      index: chunkIndex,
      startTurn,
      endTurn,
      firstTs,
      lastTs,
    });

    records.push({
      id: `${conv.entry_id}__chunk_${chunkIndex}`,
      userId: "benchmark_user",
      timestamp:
        parseTimestampMs(firstTs) ??
        parseTimestampMs(lastTs) ??
        Date.now(),
      text,
      tier: "long",
      dimensions: {
        sample_id: conv.entry_id,
        type: "beam_chunk",
        scale: conv.scale,
        chunk_index: String(chunkIndex),
        turn_start: String(startTurn),
        turn_end: String(endTurn),
      },
      metadata: {
        entryId: conv.entry_id,
        chunkIndex,
        scale: conv.scale,
        contentType: "beam_chunk",
      },
    });

    chunkIndex++;
  }

  // Index file (also a record so the agent finds it).
  const indexText = buildChunkIndex(conv, chunkSummaries);
  await writeFile(join(memoryDir, "chunk_index.md"), indexText, "utf-8");
  records.push({
    id: `${conv.entry_id}__chunk_index`,
    userId: "benchmark_user",
    timestamp: Date.now(),
    text: indexText,
    tier: "long",
    dimensions: {
      sample_id: conv.entry_id,
      type: "beam_chunk_index",
      scale: conv.scale,
    },
    metadata: {
      entryId: conv.entry_id,
      contentType: "beam_chunk_index",
      scale: conv.scale,
    },
  });

  console.log(
    `[BEAM] Wrote ${chunkIndex} chunks + index for ${conv.entry_id} → ${memoryDir}`,
  );

  return records;
}

function buildAgentPrompt(
  conv: BeamConversation,
  question: BeamProbingQuestion,
  chunkCount: number,
): string {
  const memoryPath = `~/.openloomi/data/memory/bench/beam_${conv.entry_id}/`;
  const isLarge = chunkCount > LARGE_CONVERSATION_CHUNK_THRESHOLD;

  const dateRange =
    conv.chat[0]?.timestamp && conv.chat[conv.chat.length - 1]?.timestamp
      ? `${conv.chat[0].timestamp} → ${conv.chat[conv.chat.length - 1].timestamp}`
      : "unknown";

  const largeConversationHint = isLarge
    ? `\n\n⚠️  This conversation is split across ${chunkCount} chunk files (≈${conv.chat.length} turns). DO NOT try to read every file. Instead:\n   1. Read chunk_index.md first to see the (chunk → turn range → timestamp) map.\n   2. Use a file search tool (grep / ripgrep / your shell) to locate the relevant turn ranges.\n   3. Read only the 1–5 chunk files that match the question.\n`
    : "";

  return `You are answering a question from the BEAM (Benchmarking EffecTive Agent Memory) benchmark.
The conversation history lives in chunked markdown files in your memory directory.

Memory directory: ${memoryPath}
Total turns: ${conv.chat.length}
Total chunks: ${chunkCount}
Scale: ${conv.scale}
Date range: ${dateRange}
${largeConversationHint}
QUESTION CATEGORY: ${question.category}

QUESTION: ${question.question}

CATEGORY-SPECIFIC GUIDANCE:
${
  question.category === "abstention"
    ? `- This is an ABSTENTION question. If you do not have the relevant information in your memory files, REFUSE to answer. Do not guess or hallucinate. A short "I don't know" or "I don't have that information" is the correct answer.`
    : question.category === "knowledge_update"
      ? "- This is a KNOWLEDGE-UPDATE question. Look for the LATEST statement on the topic. If earlier turns contradict a later turn, the later turn wins. If the topic was discussed but no final answer was ever confirmed, say so."
      : question.category === "contradiction_resolution"
        ? "- This is a CONTRADICTION-RESOLUTION question. The user stated something earlier and something different later. Identify both and report the later / currently-active state."
        : question.category === "multi_session_reasoning"
          ? "- This is a MULTI-SESSION question. The answer requires combining information from at least 2 distinct points in the conversation. Cite both."
          : question.category === "preference_following"
            ? `- This is a PREFERENCE question. If the user expressed multiple preferences over time, use the latest one. If no relevant preference exists, say you don't know.`
            : question.category === "temporal_reasoning"
              ? "- This is a TEMPORAL question. Use the timestamp at the top of each chunk file as the authoritative date. Calculate durations from those, not from today."
              : question.category === "event_ordering"
                ? "- This is an EVENT-ORDERING question. Use chunk timestamps to determine which event came first. State the order explicitly."
                : question.category === "instruction_following"
                  ? "- This is an INSTRUCTION-FOLLOWING question. The user gave a rule at some point; verify the rule is still active and apply it."
                  : question.category === "summarization"
                    ? "- This is a SUMMARIZATION question. Read the relevant chunks and compress them into a concise answer."
                    : "- This is an INFORMATION-EXTRACTION question. Pull the specific fact from the chunks."
}

GENERAL INSTRUCTIONS:
1. Read chunk_index.md first (always — it tells you which chunk holds which turn range).
2. Then read only the chunks you need.
3. Answer concisely, citing the chunk number(s) you used.
4. If you cannot find the answer, say "I don't know" — do not guess.`;
}

export { findAvailablePort, DEFAULT_PORTS };

export class BeamEvaluator {
  private storage: InMemoryStorageAdapter;
  private port: number;
  private authToken?: string;
  private quickLimit?: number;
  private checkpointDir: string;
  private resume: boolean;

  constructor(
    port?: number,
    tokenPath?: string,
    quickLimit?: number,
    resume = true,
  ) {
    this.storage = new InMemoryStorageAdapter();
    this.port = port || 3515;
    this.authToken = readAuthToken(tokenPath);
    this.quickLimit = quickLimit;
    this.resume = resume;
    this.checkpointDir = join(
      homedir(),
      ".openloomi",
      "data",
      "memory",
      "bench",
      "checkpoints",
      "beam",
    );
  }

  setPort(port: number): void {
    this.port = port;
  }

  private getCheckpointPath(questionId: string): string {
    return join(this.checkpointDir, `${questionId}.json`);
  }

  private async loadCheckpoint(
    questionId: string,
  ): Promise<Prediction | null> {
    if (!this.resume) return null;
    try {
      const data = await readFile(this.getCheckpointPath(questionId), "utf-8");
      return JSON.parse(data) as Prediction;
    } catch {
      return null;
    }
  }

  private async saveCheckpoint(
    questionId: string,
    prediction: Prediction,
  ): Promise<void> {
    try {
      await mkdir(this.checkpointDir, { recursive: true });
      await writeFile(
        this.getCheckpointPath(questionId),
        JSON.stringify(prediction, null, 2),
        "utf-8",
      );
    } catch (error) {
      console.error(`Failed to save checkpoint: ${error}`);
    }
  }

  /**
   * Load a BEAM conversation into storage + chunk files on disk.
   */
  async loadConversation(conv: BeamConversation): Promise<number> {
    this.storage.clear();
    const records = await writeConversationChunks(conv);
    for (const record of records) {
      this.storage.addRecord(record);
    }
    return records.length;
  }

  /**
   * Evaluate one BEAM question against the currently-loaded conversation.
   */
  async evaluateQuestion(
    conv: BeamConversation,
    question: BeamProbingQuestion,
    chunkCount: number,
  ): Promise<Prediction> {
    // Resume support — but re-judge on resume so a stale judge doesn't
    // poison the run if we re-run with a new judge model.
    const checkpoint = await this.loadCheckpoint(question.question_id);
    if (
      checkpoint?.response &&
      !checkpoint.response.startsWith("Error:") &&
      checkpoint.nugget_scores.length === question.atoms.length &&
      !checkpoint.judge_reasoning.startsWith("judge failure")
    ) {
      console.log(
        `[BEAM] Resuming from checkpoint for ${question.question_id}`,
      );
      return checkpoint;
    }

    try {
      const prompt = buildAgentPrompt(conv, question, chunkCount);
      const response = await callAgentApi(prompt, this.port, this.authToken);

      const abstained = looksLikeAbstention(response);

      let judgeResult: NuggetJudgeResult;
      if (question.atoms.length === 0) {
        console.warn(
          `[BEAM] Question ${question.question_id} has no atoms — using empty judge result`,
        );
        judgeResult = { scores: [], reasoning: "no atoms" };
      } else {
        judgeResult = await evaluateNuggetJudge(
          question.question,
          question.category,
          question.atoms,
          response,
        );
      }

      const { nugget_mean, nugget_pass } = summarizeNuggetScores(
        judgeResult.scores,
      );

      const pred: Prediction = {
        question_id: question.question_id,
        question: question.question,
        response,
        prediction: response,
        atoms: question.atoms,
        category: question.category,
        scale: conv.scale,
        nugget_scores: judgeResult.scores,
        nugget_mean,
        nugget_pass,
        judge_reasoning: judgeResult.reasoning,
        abstained,
      };

      const status = nugget_pass ? "✓" : "✗";
      console.log(
        `[BEAM] ${status} ${question.category} Q="${question.question.substring(0, 50)}..." mean=${nugget_mean.toFixed(2)}`,
      );

      await this.saveCheckpoint(question.question_id, pred);
      return pred;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`Error evaluating question: ${errorMessage}`);

      const emptyScores: number[] = question.atoms.map(() => 0);
      const pred: Prediction = {
        question_id: question.question_id,
        question: question.question,
        response: `Error: ${errorMessage}`,
        prediction: `Error: ${errorMessage}`,
        atoms: question.atoms,
        category: question.category,
        scale: conv.scale,
        nugget_scores: emptyScores,
        nugget_mean: 0,
        nugget_pass: false,
        judge_reasoning: `agent failure: ${errorMessage}`,
        abstained: false,
      };

      await this.saveCheckpoint(question.question_id, pred);
      return pred;
    }
  }
}