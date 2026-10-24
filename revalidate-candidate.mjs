import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { sha256 } from "./manual-apply.mjs";
import { callQwen } from "./ollama-client.mjs";
import { buildQaPrompt, parseQa } from "./candidate-qa.mjs";
import { parseProposal, proposalPolicyViolation } from "./proposal-validation.mjs";
import { runCandidateTypecheck } from "./candidate-typecheck.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(root, "agent-config.json"), "utf8"));
const target = "src/app/page.tsx";
const summary = process.argv[2];
const valid = parseProposal(JSON.stringify({ status: "WAITING_FOR_HUMAN_APPROVAL", target, action: "CREATE_CANDIDATE_ONLY", summary }), target);
const formal = path.join(config.workspace, target);
const candidate = path.join(root, "candidates/page.candidate.tsx");
const manifest = path.join(root, "candidates/page.candidate.manifest.json");
let before;
try {
  if (!valid || proposalPolicyViolation(valid.summary)) throw new Error("APPROVED_SUMMARY_REQUIRED_OR_UNSUPPORTED");
  if (config.allowAutoRead !== true || config.allowCandidateWrite !== true || config.approvalRequired !== true || config.approvalMode !== "human" || config.allowAutoWrite !== false) throw new Error("REVALIDATION_POLICY_INVALID");
  const originalSource = fs.readFileSync(formal, "utf8");
  const candidateSource = fs.readFileSync(candidate, "utf8");
  before = sha256(fs.readFileSync(formal));
  const candidateHash = sha256(fs.readFileSync(candidate));
  // Any failed revalidation must leave no valid application receipt.
  if (fs.existsSync(manifest)) fs.unlinkSync(manifest);
  let diff;
  try { diff = execFileSync("git", ["--no-pager", "diff", "--no-index", "--", formal, candidate], { encoding: "utf8", windowsHide: true }); }
  catch (error) { if (error.status !== 1) throw error; diff = String(error.stdout); }
  if (!diff.trim()) throw new Error("NO_ACTUAL_CODE_CHANGE");
  console.log("REVALIDATING_EXISTING_CANDIDATE");
  const response = await callQwen(config, buildQaPrompt({ summary: valid.summary, originalSource, candidateSource, diff }));
  console.log(response);
  const qa = parseQa(response);
  if (!qa.passed) throw new Error(`QA_REJECTED: ${qa.reason}`);
  console.log("QA_GATE=PASSED");
  const checked = await runCandidateTypecheck(config.workspace, candidate, target);
  if (!checked.passed) throw new Error(`TYPECHECK_REJECTED: ${checked.reason}`);
  console.log("TYPECHECK_GATE=PASSED");
  if (sha256(fs.readFileSync(formal)) !== before || sha256(fs.readFileSync(candidate)) !== candidateHash) throw new Error("FILES_CHANGED_DURING_REVALIDATION");
  fs.writeFileSync(manifest, JSON.stringify({ version: 1, workspace: path.resolve(config.workspace), target, summary: valid.summary, formalHash: before, candidateHash, qa: "PASS", typecheck: "PASS" }, null, 2) + "\n");
  console.log("MANUAL_APPLY_MANIFEST=READY");
} catch (error) {
  console.error(`REVALIDATION_ERROR=${error.message}`);
  process.exitCode = 1;
} finally {
  if (before) {
    const unchanged = sha256(fs.readFileSync(formal)) === before;
    console.log(`FORMAL_INTEGRITY_GATE=${unchanged ? "PASSED" : "VIOLATION"}`);
    if (!unchanged) process.exitCode = 1;
  }
  console.log("FORMAL_WRITE=NOT_PERFORMED");
}
