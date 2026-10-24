import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runCandidateTypecheck } from "./candidate-typecheck.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(root, "agent-config.json"), "utf8"));
const workspace = config.workspace;
const formal = path.join(workspace, "src/app/page.tsx");
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const before = hash(formal);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "aios-v15-validation-"));
const write = (file, text) => fs.writeFileSync(path.join(fixture, file), text);
const check = async (name, candidate, expected, reason) => {
  write("candidate.txt", candidate);
  const result = await runCandidateTypecheck(fixture, path.join(fixture, "candidate.txt"), "page.ts");
  assert.equal(result.passed, expected, `${name}: ${result.reason}`);
  if (reason) assert.match(result.reason, reason);
  console.log(`PASS ${name}`);
};
try {
  // Only the junction itself is removed during cleanup; its target is never traversed.
  fs.symlinkSync(path.join(workspace, "node_modules"), path.join(fixture, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  write("package.json", '{"type":"module"}');
  write("tsconfig.json", JSON.stringify({ compilerOptions: { noEmit: true, strict: true, skipLibCheck: true, module: "esnext", moduleResolution: "bundler", target: "es2017" }, include: ["page.ts", "consumer.ts"] }));
  write("page.ts", 'export const value: number = 1;');
  write("consumer.ts", 'import { value } from "./page"; const result: number = value;');
  const fixtureBefore = hash(path.join(fixture, "page.ts"));
  await check("valid candidate", 'export const value: number = 2;', true);
  await check("candidate type error", 'export const value: number = "bad";', false, /TS2322/);
  await check("consumer sees replacement exports", 'export const value: string = "changed";', false, /consumer\.ts.*TS2322/);
  await check("candidate syntax error", 'export const value = ;', false, /TS/);
  write("tsconfig.json", '{"compilerOptions":{"noEmit":true},"files":["consumer.ts"]}');
  write("consumer.ts", 'export const unrelated = 1;');
  await check("excluded target rejected", 'export const value = 2;', false, /TYPECHECK_TARGET_NOT_INCLUDED/);
  assert.equal(hash(path.join(fixture, "page.ts")), fixtureBefore);
  const actual = await runCandidateTypecheck(workspace, formal, "src/app/page.tsx");
  assert.equal(actual.passed, true, actual.reason);
  console.log("PASS actual project baseline via virtual filesystem");
  assert.equal(hash(formal), before);
  assert.equal(fs.existsSync(path.join(workspace, "src/app/__aios_candidate_typecheck__.tsx")), false);
  console.log("PASS formal files unchanged; no temporary TSX created");
} finally {
  if (fs.existsSync(path.join(fixture, "node_modules"))) fs.unlinkSync(path.join(fixture, "node_modules"));
  // Delete only the exact temporary directory created by mkdtemp above.
  fs.rmSync(fixture, { recursive: true, force: true });
}
