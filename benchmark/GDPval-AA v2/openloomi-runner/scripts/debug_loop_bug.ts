// Reproduce the SSE record parsing loop in isolation to see if it
// truly infinite-loops on a single-chunk record.
let buffer = 'data: {"type":"session","sessionId":"abc","messageId":"msg_1"}\n\n';
let totalIterations = 0;
let totalWrites = 0;
const maxIters = 1000; // bail to avoid hanging the test
const sep = buffer.indexOf("\n\n");  // <-- the buggy version uses `const`
console.log(`[debug] initial sep=${sep}`);
while (sep !== -1 && totalIterations < maxIters) {
  totalIterations += 1;
  const record = buffer.slice(0, sep);
  buffer = buffer.slice(sep + 2);
  totalWrites += 1;
  console.log(`[debug] iter=${totalIterations} record.length=${record.length} buffer.length=${buffer.length}`);
}
console.log(`[debug] total iters: ${totalIterations}, total writes: ${totalWrites}`);