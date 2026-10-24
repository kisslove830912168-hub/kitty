import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// TypeScript 7 virtual filesystem: candidate content is read at the formal path.
// No source file, temporary TSX, output file, or incremental cache is written.
export async function runCandidateTypecheck(workspace, candidateFile, relativeTarget) {
  let api;
  let snapshot;
  try {
    const root = path.resolve(workspace);
    const target = path.resolve(root, relativeTarget);
    const relative = path.relative(root, target);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return { passed: false, reason: "TARGET_OUTSIDE_WORKSPACE" };
    }
    const configFile = path.join(root, "tsconfig.json");
    if (!fs.existsSync(configFile)) return { passed: false, reason: "TYPECHECK_CONFIG_NOT_FOUND" };
    if (!fs.existsSync(target)) return { passed: false, reason: "TYPECHECK_TARGET_NOT_FOUND" };
    const source = fs.readFileSync(candidateFile, "utf8");
    const require = createRequire(path.join(root, "package.json"));
    let apiPath;
    try {
      apiPath = require.resolve("typescript/unstable/sync");
    } catch {
      return { passed: false, reason: "TYPECHECK_API_NOT_AVAILABLE" };
    }
    const { API, DiagnosticCategory } = await import(pathToFileURL(apiPath).href);
    const canonical = (file) => {
      const resolved = path.resolve(root, file);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    let candidateRead = false;
    api = new API({
      cwd: root,
      fs: {
        readFile(file) {
          if (canonical(file) === canonical(target)) {
            candidateRead = true;
            return source;
          }
          return undefined;
        },
        writeFile() { throw new Error("TYPECHECK_WRITE_BLOCKED"); },
        removeFile() { throw new Error("TYPECHECK_DELETE_BLOCKED"); },
      },
    });
    snapshot = api.updateSnapshot({ openProjects: [configFile] });
    const project = snapshot.getProject(configFile);
    if (!project) return { passed: false, reason: "TYPECHECK_PROJECT_NOT_LOADED" };
    const program = project.program;
    if (!program.getSourceFileNames().some((file) => canonical(file) === canonical(target))) {
      return { passed: false, reason: "TYPECHECK_TARGET_NOT_INCLUDED" };
    }
    const diagnostics = [
      ...program.getConfigFileParsingDiagnostics(),
      ...program.getProgramDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getBindDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ].filter((item) => item.category === DiagnosticCategory.Error);
    if (!candidateRead) return { passed: false, reason: "TYPECHECK_CANDIDATE_NOT_READ" };
    if (diagnostics.length) {
      return {
        passed: false,
        reason: diagnostics.map((item) => `${item.fileName || configFile}:${item.pos} TS${item.code}: ${item.text}`).join("\n"),
      };
    }
    return { passed: true, reason: "TYPECHECK_PASS" };
  } catch (error) {
    return { passed: false, reason: error?.message || "TYPECHECK_FAILED" };
  } finally {
    try { snapshot?.dispose(); } finally { api?.close(); }
  }
}
