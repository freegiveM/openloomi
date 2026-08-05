// Shared types for the GDPval-AA v2 OpenLoomi runner.
//
// Each prediction captures everything we need to (a) know what the harness
// did, (b) find the real file deliverables on disk, and (c) feed the
// pair-wise grader downstream.

export interface GDPvalAATask {
  task_id: string;
  prompt: string;
  /** Free-form metadata from the upstream dataset (occupation, sector, etc). */
  metadata?: Record<string, unknown>;
  /** Verbatim upstream row, including any reference file entries. */
  raw?: Record<string, unknown>;
}

export interface GDPvalAADeliverable {
  /** Path inside the task's workDir where the file ended up. */
  workdir_path: string;
  /** Path under results/artifacts/ after the run copies it into the archive. */
  archive_path?: string;
  /** Snapshot path reported by the agent (`.snapshots/<hash>`), if any. */
  snapshot_path?: string;
  /** File size in bytes. */
  size_bytes: number;
  /** SHA-256 of the file contents (lowercase hex). */
  sha256: string;
  /** Mime type guessed from the file extension. */
  mime_type: string;
}

export interface GDPvalAAPrediction {
  task_id: string;
  prompt: string;
  /** Concatenated assistant text emitted by the agent (excluding tool traffic). */
  response: string;
  metadata?: Record<string, unknown>;
  /** Absolute workDir the agent was given for this task. */
  work_dir: string;
  /** Real file deliverables the agent produced (PDFs, slides, spreadsheets, etc). */
  deliverables: GDPvalAADeliverable[];
  /** Names of tools the agent invoked, in order. */
  tool_calls: string[];
  /** Number of LLM turns consumed (best-effort: one result message == one turn). */
  turn_count: number;
  /** Resolved OpenLoomi session id, when the harness surfaces one. */
  session_id?: string;
  /** Wall-clock duration in ms for the task run. */
  duration_ms: number;
  /** Input/output token usage reported by the harness `result` event, if any. */
  usage?: { input_tokens: number; output_tokens: number };
  /** Set when the run failed before producing a result. */
  error?: string;
}

export interface GDPvalAARunResult {
  dataset: string;
  started_at: string;
  finished_at?: string;
  model: string;
  provider: string;
  tasks_run: number;
  success_count: number;
  error_count: number;
  /** Per-task predictions. */
  predictions: GDPvalAAPrediction[];
}
