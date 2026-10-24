import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// Reject linked path components, including junctions, before any formal write.
function plainPath(root, relative) {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  const rel = path.relative(base, target);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("PATH_OUTSIDE_ROOT");
  let cursor = path.parse(base).root;
  for (const part of target.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error("LINKED_PATH_BLOCKED");
  }
  return target;
}

export async function applyCandidate({ agentRoot, config, approve, validate }) {
  if (config.approvalRequired !== true || config.approvalMode !== "human" || config.allowManualApply !== true || config.allowAutoWrite !== false) {
    throw new Error("MANUAL_APPLY_POLICY_INVALID");
  }
  const target = plainPath(config.workspace, "src/app/page.tsx");
  const candidate = plainPath(agentRoot, "candidates/page.candidate.tsx");
  const manifestFile = plainPath(agentRoot, "candidates/page.candidate.manifest.json");
  const lockFile = plainPath(agentRoot, "candidates/manual-apply.lock");
  const lock = fs.openSync(lockFile, "wx");
  let temporary;
  let backup;
  let wrote = false;
  let original;
  let candidateHash;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (manifest.version !== 1 || manifest.target !== "src/app/page.tsx" || manifest.workspace !== path.resolve(config.workspace) || manifest.qa !== "PASS" || manifest.typecheck !== "PASS") throw new Error("CANDIDATE_MANIFEST_INVALID");
    original = fs.readFileSync(target);
    const replacement = fs.readFileSync(candidate);
    candidateHash = sha256(replacement);
    const ensureUnchanged = () => {
      plainPath(config.workspace, "src/app/page.tsx");
      plainPath(agentRoot, "candidates/page.candidate.tsx");
      if (sha256(fs.readFileSync(target)) !== manifest.formalHash) throw new Error("FORMAL_CHANGED_SINCE_PROPOSAL");
      if (sha256(fs.readFileSync(candidate)) !== manifest.candidateHash) throw new Error("CANDIDATE_CHANGED_SINCE_VALIDATION");
    };
    ensureUnchanged();
    if (candidateHash === sha256(original)) throw new Error("NO_ACTUAL_CODE_CHANGE");
    const checked = await validate(config.workspace, candidate, manifest.target);
    if (!checked.passed) throw new Error(`PRE_APPLY_TYPECHECK_FAILED: ${checked.reason}`);
    ensureUnchanged();
    const token = `APPLY ${candidateHash}`;
    if (await approve({ target, candidate, summary: manifest.summary, token }) !== token) return { status: "CANCELLED", formalModified: false };
    ensureUnchanged();
    const backupDir = plainPath(agentRoot, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    backup = plainPath(agentRoot, `backups/page-${Date.now()}-${randomUUID()}.bak`);
    fs.writeFileSync(backup, original, { flag: "wx" });
    if (sha256(fs.readFileSync(backup)) !== manifest.formalHash) throw new Error("BACKUP_VERIFICATION_FAILED");
    temporary = plainPath(config.workspace, `src/app/.aios-apply-${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, replacement, { flag: "wx", mode: fs.statSync(target).mode });
    ensureUnchanged();
    fs.renameSync(temporary, target);
    temporary = undefined;
    wrote = true;
    if (sha256(fs.readFileSync(target)) !== candidateHash) throw new Error("APPLY_HASH_MISMATCH");
    const after = await validate(config.workspace, target, manifest.target);
    if (!after.passed) throw new Error(`POST_APPLY_TYPECHECK_FAILED: ${after.reason}`);
    if (sha256(fs.readFileSync(target)) !== candidateHash) throw new Error("FORMAL_CHANGED_DURING_VALIDATION");
    return { status: "APPLIED", backup, formalHash: candidateHash };
  } catch (error) {
    if (wrote) {
      // Never overwrite an external edit made after our replacement.
      if (sha256(fs.readFileSync(target)) !== candidateHash) throw new Error(`ROLLBACK_BLOCKED_EXTERNAL_CHANGE; BACKUP=${backup}; ${error.message}`);
      temporary = plainPath(config.workspace, `src/app/.aios-rollback-${randomUUID()}.tmp`);
      fs.writeFileSync(temporary, original, { flag: "wx", mode: fs.statSync(target).mode });
      fs.renameSync(temporary, target);
      temporary = undefined;
      if (sha256(fs.readFileSync(target)) !== sha256(original)) throw new Error(`ROLLBACK_VERIFICATION_FAILED; BACKUP=${backup}`);
      throw new Error(`APPLY_FAILED_ROLLED_BACK; BACKUP=${backup}; ${error.message}`);
    }
    throw error;
  } finally {
    if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    fs.closeSync(lock);
    fs.unlinkSync(lockFile);
  }
}
