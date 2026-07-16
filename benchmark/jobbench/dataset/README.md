# JobBench dataset files

Generated JSONL files are ignored by git by default.

Expected converted format per line:

```json
{
  "task_id": "...",
  "prompt": "...",
  "metadata": {},
  "raw": {}
}
```

Use `dataset/convert.py` to normalize rows from a Hugging Face JobBench dataset repo.
