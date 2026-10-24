import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { applyCandidate } from "./manual-apply.mjs";
import { runCandidateTypecheck } from "./candidate-typecheck.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(root, "agent-config.json"), "utf8"));
try {
  const result = await applyCandidate({
    agentRoot: root, config, validate: runCandidateTypecheck,
    async approve({ target, candidate, summary, token }) {
      console.log(`PROPOSAL=${summary}\nTARGET=${target}`);
      try {
        console.log(execFileSync("git", ["--no-pager", "diff", "--no-index", "--", target, candidate], { encoding: "utf8", windowsHide: true }));
      } catch (error) {
        if (error.status !== 1) throw error;
        console.log(String(error.stdout));
      }
      console.log(`To apply this exact candidate, type:\n${token}`);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try { return (await rl.question("Confirmation (anything else cancels): ")).trim(); }
      finally { rl.close(); }
    },
  });
  console.log(JSON.stringify(result, null, 2));
  console.log("GIT_COMMIT=NOT_PERFORMED");
} catch (error) {
  console.error(`MANUAL_APPLY_ERROR=${error.message}`);
  process.exitCode = 1;
}
