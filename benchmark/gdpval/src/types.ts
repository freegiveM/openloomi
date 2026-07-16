export interface GDPvalTask {
  task_id: string;
  prompt: string;
  metadata?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface GDPvalPrediction {
  task_id: string;
  prompt: string;
  response: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

export interface GDPvalRunResult {
  dataset: string;
  tasks_run: number;
  success_count: number;
  error_count: number;
  predictions: GDPvalPrediction[];
}
