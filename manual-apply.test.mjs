import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { applyCandidate, sha256 } from "./manual-apply.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aios-manual-apply-"));
const root = path.join(temp, "agent");
const workspace = path.join(temp, "app");
fs.mkdirSync(path.join(root, "candidates"), { recursive: true });
fs.mkdirSync(path.join(workspace, "src/app"), { recursive: true });
const formal = path.join(workspace, "src/app/page.tsx");
const candidate = path.join(root, "candidates/page.candidate.tsx");
const config = { workspace, approvalRequired: true, approvalMode: "human", allowManualApply: true, allowAutoWrite: false };
const original = "export default function Home() { return null; }\n";
const replacement = "// Candidate\n" + original;
function reset() {
  fs.writeFileSync(formal, original);
  fs.writeFileSync(candidate, replacement);
  fs.writeFileSync(path.join(root, "candidates/page.candidate.manifest.json"), JSON.stringify({ version: 1, workspace, target: "src/app/page.tsx", formalHash: sha256(original), candidateHash: sha256(replacement), summary: "Add a comment", qa: "PASS", typecheck: "PASS" }));
}
const options = { agentRoot: root, config, approve: async ({ token }) => token, validate: async () => ({ passed: true }) };
async function rejected(name, override, pattern) {
  reset();
  await assert.rejects(() => applyCandidate({ ...options, ...override }), pattern);
  assert.equal(fs.readFileSync(formal, "utf8"), original);
  console.log(`PASS ${name}`);
}
try {
  reset();
  const cancel = await applyCandidate({ ...options, approve: async () => "NO" });
  assert.equal(cancel.status, "CANCELLED");
  assert.equal(fs.readFileSync(formal, "utf8"), original);
  assert.equal(fs.existsSync(path.join(root, "backups")), false);
  console.log("PASS cancellation writes no formal file or backup");
  await rejected("manual policy required", { config: { ...config, allowManualApply: false } }, /POLICY_INVALID/);
  reset(); fs.writeFileSync(formal, "external edit");
  await assert.rejects(() => applyCandidate(options), /FORMAL_CHANGED/);
  assert.equal(fs.readFileSync(formal, "utf8"), "external edit");
  console.log("PASS stale formal rejected");
  reset(); fs.appendFileSync(candidate, "tamper");
  await assert.rejects(() => applyCandidate(options), /CANDIDATE_CHANGED/);
  console.log("PASS tampered candidate rejected");
  await rejected("failed precheck blocks write", { validate: async () => ({ passed: false, reason: "test error" }) }, /PRE_APPLY/);
  await rejected("candidate changed during approval rejected", { approve: async ({ token }) => { fs.appendFileSync(candidate, "tamper"); return token; } }, /CANDIDATE_CHANGED/);
  let calls = 0;
  await rejected("failed postcheck restores original", { validate: async () => ({ passed: ++calls === 1, reason: "postcheck error" }) }, /APPLY_FAILED_ROLLED_BACK/);
  reset();
  const success = await applyCandidate(options);
  assert.equal(success.status, "APPLIED");
  assert.equal(fs.readFileSync(formal, "utf8"), replacement);
  assert.equal(fs.readFileSync(success.backup, "utf8"), original);
  console.log("PASS approved apply with verified backup");
  reset();
  let concurrentCalls = 0;
  await assert.rejects(() => applyCandidate({ ...options, validate: async () => {
    if (++concurrentCalls === 2) fs.writeFileSync(formal, "new external edit");
    return { passed: true };
  } }), /ROLLBACK_BLOCKED_EXTERNAL_CHANGE/);
  assert.equal(fs.readFileSync(formal, "utf8"), "new external edit");
  console.log("PASS rollback preserves external edit");
  assert.equal(fs.existsSync(path.join(root, "candidates/manual-apply.lock")), false);
} finally {
  // Exact mkdtemp directory only; fixtures contain no links.
  fs.rmSync(temp, { recursive: true, force: true });
}
