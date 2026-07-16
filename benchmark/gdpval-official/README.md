# GDPval official evaluation notes

GDPval does not appear to provide a full open-source local judge repository like JobBench.
The official paper evaluates model deliverables with head-to-head expert review against human expert deliverables, and mentions an experimental automatic grader service.

Official sources:

- Paper: https://arxiv.org/abs/2510.04374
- Dataset: https://huggingface.co/datasets/openai/gdpval
- Official grader service mentioned by the paper: https://evals.openai.com

How this differs from the local OpenLoomi wrapper:

- benchmark/gdpval/results/\*.json stores prompts, responses, and program-level errors.
- That file is not an official GDPval score.
- Official GDPval-style scoring requires evaluating final deliverables, not just response text.
- The closest official method is expert pairwise comparison / win rate.
- If using the automatic grader service, submit model deliverables according to the service requirements and report that score separately.

Recommended next step for OpenLoomi:

1. Run each GDPval task so OpenLoomi writes real deliverables into the task/session folder.
2. Package the deliverables by task_id.
3. Evaluate them with official GDPval grader if access is available, or with a clearly-labeled approximate rubric judge if not.
4. Do not report success_count/error_count as GDPval accuracy.
