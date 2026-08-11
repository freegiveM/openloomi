// Debug script: verify topLevelSignature actually filters _openloomi_sse_debug
import { readdirSync } from "node:fs";
import { topLevelSignature } from "../src/agent";

const wd = "D:/openloomi3/openloomi/results/workdirs/83d10b06-26d1-4636-a32c-23f92c57f30b";
console.log("[debug] actual dir entries:");
for (const e of readdirSync(wd, { withFileTypes: true })) {
  console.log(`  ${e.isFile() ? "FILE" : "DIR"} ${e.name}`);
}
const ignore = ["_openloomi_sse_debug", "Population_v2.xlsx", "Population%20v2.xlsx"];
console.log(`[debug] ignore list: ${JSON.stringify(ignore)}`);
console.log(`[debug] "Population%20v2.xlsx".includes("Population_v2.xlsx"):`, "Population%20v2.xlsx".includes("Population_v2.xlsx"));
console.log(`[debug] "_openloomi_sse_debug".includes("Population%20v2.xlsx"):`, "_openloomi_sse_debug".includes("Population%20v2.xlsx"));
const sig2 = topLevelSignature(wd, ignore);
console.log("[debug] WITH filter:");
console.log(sig2);
console.log("---");