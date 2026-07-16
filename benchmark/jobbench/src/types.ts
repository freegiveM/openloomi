export interface JobBenchTask {
  task_id: string;
  prompt: string;
  metadata?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface JobBenchPrediction {
  task_id: string;
  prompt: string;
  response: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

export interface JobBenchRunResult {
  dataset: string;
  tasks_run: number;
  success_count: number;
  error_count: number;
  predictions: JobBenchPrediction[];
}
