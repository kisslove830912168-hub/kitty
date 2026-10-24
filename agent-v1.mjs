import fs from "fs";
import path from "path";
import readline from "readline";
import { execFileSync } from "child_process";
import { createHash } from "crypto";

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const CONFIG_PATH = path.join(ROOT, "agent-config.json");
const CANDIDATE_DIR = path.join(ROOT, "candidates");

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function callQwen(config, prompt) {
  const response = await fetch(config.ollamaUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      prompt,
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`OLLAMA_HTTP_${response.status}`);
  }

  const data = await response.json();
  return String(data.response || "").trim();
}

function safeTarget(workspace, relativeTarget) {
  const workspaceAbs = path.resolve(workspace);
  const targetAbs = path.resolve(workspaceAbs, relativeTarget);

  const relative = path.relative(workspaceAbs, targetAbs);

  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error("TARGET_OUTSIDE_WORKSPACE");
  }

  return targetAbs;
}

function sha256File(filePath) {
  const data = fs.readFileSync(filePath);
  return createHash("sha256").update(data).digest("hex");
}

function extractField(text, field) {
  const regex = new RegExp(`^${field}=(.*)$`, "mi");
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

function cleanCandidateSource(text) {
  let cleaned = String(text || "").trim();

  cleaned = cleaned
    .replace(/^```(?:tsx|typescript|ts|jsx|javascript|js)?\s*/i, "")
    .replace(/\s*```$/i, "");

  return cleaned.trim() + "\n";
}

function runDiff(formalFile, candidateFile) {
  try {
    const output = execFileSync(
      "git",
      [
        "diff",
        "--no-index",
        "--",
        formalFile,
        candidateFile,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    return output || "";
  } catch (error) {
    // git diff returns exit code 1 when files are different.
    if (error.status === 1) {
      return String(error.stdout || "");
    }

    throw error;
  }
}

function runNumstat(formalFile, candidateFile) {
  try {
    return execFileSync(
      "git",
      [
        "diff",
        "--no-index",
        "--numstat",
        "--",
        formalFile,
        candidateFile,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    ).trim();
  } catch (error) {
    if (error.status === 1) {
      return String(error.stdout || "").trim();
    }

    throw error;
  }
}

function parseNumstat(numstat) {
  if (!numstat) {
    return {
      added: 0,
      deleted: 0,
    };
  }

  const firstLine = numstat.split(/\r?\n/)[0];
  const parts = firstLine.split(/\s+/);

  return {
    added: Number.parseInt(parts[0], 10) || 0,
    deleted: Number.parseInt(parts[1], 10) || 0,
  };
}
function runCandidateTypecheck(workspace, candidateFile, relativeTarget) {
  const workspaceRoot = path.resolve(workspace);
  const targetFile = safeTarget(workspaceRoot, relativeTarget);
  const targetDir = path.dirname(targetFile);
  const tempFile = path.join(targetDir, "__aios_candidate_typecheck__.tsx");
  const tscJs = path.join(
    workspaceRoot,
    "node_modules",
    "typescript",
    "bin",
    "tsc"
  );

  if (!fs.existsSync(tscJs)) {
    return {
      passed: false,
      reason: "TYPECHECK_TOOL_NOT_FOUND",
    };
  }

  if (fs.existsSync(tempFile)) {
    return {
      passed: false,
      reason: "TYPECHECK_TEMP_FILE_ALREADY_EXISTS",
    };
  }

  try {
    fs.copyFileSync(candidateFile, tempFile);

    execFileSync(
      process.execPath,
      [tscJs, "--noEmit"],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    return {
      passed: true,
      reason: "TYPECHECK_PASS",
    };
  } catch (error) {
    const output = [
      String(error?.stdout || "").trim(),
      String(error?.stderr || "").trim(),
    ]
      .filter(Boolean)
      .join("\n");

    return {
      passed: false,
      reason: output || error?.message || "TYPECHECK_FAILED",
    };
  } finally {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}
async function main() {
  const config = loadConfig();

  console.log("=== AIOS Agent V1.3 ===");
  console.log(`Agent: ${config.agentName}`);
  console.log(`Workspace: ${config.workspace}`);
  console.log(`Approval Required: ${config.approvalRequired}`);
  console.log(`Approval Mode: ${config.approvalMode}`);
  console.log(`Candidate Write: ${config.allowCandidateWrite}`);
  console.log(`Formal Write: ${config.allowAutoWrite}`);
  console.log("");

  const relativeTarget = "src/app/page.tsx";
  const formalFile = safeTarget(config.workspace, relativeTarget);

  if (!config.allowAutoRead) {
    console.log("READ_BLOCKED_BY_CONFIG");
    return;
  }

  if (!fs.existsSync(formalFile)) {
    console.log("READ_FAILED");
    console.log(`FILE_NOT_FOUND=${relativeTarget}`);
    return;
  }

  const originalSource = fs.readFileSync(formalFile, "utf8");
  const formalHashBefore = sha256File(formalFile);
  try {

  console.log("READ_OK");
  console.log(`FILE=${relativeTarget}`);
  console.log(`SIZE=${Buffer.byteLength(originalSource, "utf8")}`);
  console.log("");

  if (!config.allowProposalGeneration) {
    console.log("PROPOSAL_BLOCKED_BY_CONFIG");
    return;
  }

  console.log("Requesting proposal from local Qwen...");
  console.log("");

  const proposalPrompt = `
You are the proposal engine for AIOS Agent.

Analyze this Next.js/TypeScript source file.

You MUST NOT claim that you changed any file.
You MUST NOT output code.
You MUST propose only one small, reviewable improvement.

Return EXACTLY these four lines:

PROPOSAL_STATUS=WAITING_FOR_HUMAN_APPROVAL
TARGET=${relativeTarget}
ACTION=CREATE_CANDIDATE_ONLY
SUMMARY=<one concise sentence describing the exact intended code change>

SOURCE:
${originalSource}
`;

  const proposal = await callQwen(config, proposalPrompt);

  console.log("Qwen proposal:");
  console.log(proposal);
  console.log("");

  const proposalStatus = extractField(proposal, "PROPOSAL_STATUS");
  const proposalTarget = extractField(proposal, "TARGET");
  const proposalAction = extractField(proposal, "ACTION");
  const proposalSummary = extractField(proposal, "SUMMARY");

  if (
    proposalStatus !== "WAITING_FOR_HUMAN_APPROVAL" ||
    proposalTarget !== relativeTarget ||
    proposalAction !== "CREATE_CANDIDATE_ONLY" ||
    !proposalSummary
  ) {
    console.log("PROPOSAL_FORMAT_INVALID");
    console.log("NO_FILES_WRITTEN");
    return;
  }

  console.log("SAFETY BEFORE APPROVAL:");
  console.log("FORMAL_WRITE=BLOCKED");
  console.log("DELETE=BLOCKED");
  console.log("GIT_COMMIT=BLOCKED");
  console.log("");

  if (!config.approvalRequired || config.approvalMode !== "human") {
    console.log("HUMAN_APPROVAL_POLICY_INVALID");
    console.log("NO_FILES_WRITTEN");
    return;
  }

  const approval = await ask(
    "Type APPROVE to create a candidate file, or anything else to cancel: "
  );

  if (approval !== "APPROVE") {
    console.log("");
    console.log("CANCELLED_BY_HUMAN");
    console.log("NO_FILES_WRITTEN");
    return;
  }

  console.log("");
  console.log("HUMAN_APPROVAL_RECEIVED");

  if (!config.allowCandidateWrite) {
    console.log("CANDIDATE_WRITE_BLOCKED_BY_CONFIG");
    console.log("NO_FILES_WRITTEN");
    return;
  }

  if (config.allowAutoWrite) {
    console.log("UNSAFE_CONFIG_DETECTED");
    console.log("FORMAL_WRITE_MUST_REMAIN_FALSE");
    console.log("NO_FILES_WRITTEN");
    return;
  }

  console.log("Generating candidate source...");

  const candidatePrompt = `
You are generating a CANDIDATE ONLY.

The candidate will NOT automatically replace the formal project file.

Implement ONLY this approved proposal:

${proposalSummary}

Rules:
- Preserve all unrelated behavior.
- Preserve existing imports and components unless the approved proposal requires a change.
- Do not invent unrelated features.
- Do not delete existing sections unless explicitly required by the proposal.
- Return ONLY the complete final TSX source.
- No Markdown fences.
- No explanation.

ORIGINAL SOURCE:
${originalSource}
`;

  const rawCandidate = await callQwen(config, candidatePrompt);
  const candidateSource = cleanCandidateSource(rawCandidate);

  fs.mkdirSync(CANDIDATE_DIR, {
    recursive: true,
  });

  const candidateFile = path.join(
    CANDIDATE_DIR,
    "page.candidate.tsx"
  );

  fs.writeFileSync(candidateFile, candidateSource, "utf8");

  console.log("");
  console.log("CANDIDATE_CREATED");
  console.log(`CANDIDATE=${candidateFile}`);
  console.log("");

  // -----------------------------
  // V1.3 AUTOMATIC DIFF QA GATE
  // -----------------------------

  console.log("=== AUTOMATIC CANDIDATE QA ===");

  const diff = runDiff(formalFile, candidateFile);
  const numstat = runNumstat(formalFile, candidateFile);
  const stats = parseNumstat(numstat);

  console.log(`LINES_ADDED=${stats.added}`);
  console.log(`LINES_DELETED=${stats.deleted}`);

  if (!diff.trim()) {
    console.log("QA_RESULT=REJECT");
    console.log("QA_REASON=NO_ACTUAL_CODE_CHANGE");
    console.log("");
    console.log("FORMAL_PROJECT_NOT_MODIFIED");
    console.log("DELETE=BLOCKED");
    console.log("GIT_COMMIT=BLOCKED");
    console.log("NEXT_STEP=NEW_PROPOSAL_REQUIRED");
    return;
  }

  const qaPrompt = `
You are a strict QA reviewer.

Compare the approved proposal with the ACTUAL git diff.

APPROVED PROPOSAL:
${proposalSummary}

ACTUAL DIFF:
${diff}

Decide whether the actual diff genuinely implements the approved proposal.

Reject if:
- the diff is only formatting, punctuation, whitespace, or semicolon changes;
- the claimed feature is not actually implemented;
- unrelated behavior is changed;
- existing functionality is removed without justification;
- the diff does not match the proposal.

Return EXACTLY three lines:

QA_STATUS=PASS or REJECT
QA_MATCH=true or false
QA_REASON=<one concise sentence>
`;

  const qaResponse = await callQwen(config, qaPrompt);

  console.log("");
  console.log("Qwen QA:");
  console.log(qaResponse);
  console.log("");

  const qaStatus = extractField(qaResponse, "QA_STATUS");
  const qaMatch = extractField(qaResponse, "QA_MATCH");
  const qaReason = extractField(qaResponse, "QA_REASON");

  if (
    qaStatus !== "PASS" ||
    qaMatch !== "true"
  ) {
    console.log("QA_GATE=REJECTED");
    console.log(`QA_REASON=${qaReason || "PROPOSAL_DIFF_MISMATCH"}`);
    console.log("");
    console.log("FORMAL_PROJECT_NOT_MODIFIED");
    console.log("DELETE=BLOCKED");
    console.log("GIT_COMMIT=BLOCKED");
    console.log("NEXT_STEP=NEW_PROPOSAL_REQUIRED");
    return;
  }

  console.log("QA_GATE=PASSED");
console.log("TYPECHECK_GATE=RUNNING");

const typecheckResult = runCandidateTypecheck(
  config.workspace,
  candidateFile,
  relativeTarget
);

if (!typecheckResult.passed) {
  console.log("TYPECHECK_GATE=REJECTED");
  console.log(`TYPECHECK_REASON=${typecheckResult.reason}`);
  console.log("");
  console.log("FORMAL_PROJECT_NOT_MODIFIED");
  console.log("DELETE=BLOCKED");
  console.log("GIT_COMMIT=BLOCKED");
  console.log("NEXT_STEP=NEW_PROPOSAL_REQUIRED");
  return;
}

console.log("TYPECHECK_GATE=PASSED");
console.log("CANDIDATE_READY_FOR_FURTHER_VALIDATION");
console.log("");
console.log("FORMAL_PROJECT_NOT_MODIFIED");
console.log("DELETE=BLOCKED");
console.log("GIT_COMMIT=BLOCKED");
console.log("NEXT_STEP=FURTHER_VALIDATION_REQUIRED");
}
  finally {
    const formalHashAfter = sha256File(formalFile);
    console.log(`FORMAL_INTEGRITY_BEFORE=${formalHashBefore}`);
    console.log(`FORMAL_INTEGRITY_AFTER=${formalHashAfter}`);
    const formalIntegrityPassed = formalHashBefore === formalHashAfter;
    if (!formalIntegrityPassed) {
      console.error("FORMAL_INTEGRITY_GATE=VIOLATION");
      process.exitCode = 1;
    } else {
      console.log("FORMAL_INTEGRITY_GATE=PASSED");
    }
  }
}

main().catch((error) => {
  console.error("");
  console.error("AGENT_ERROR");
  console.error(error?.message || error);
  process.exitCode = 1;
});



