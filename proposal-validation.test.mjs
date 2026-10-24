import assert from "node:assert/strict";
import { parseProposal, proposalSchema, proposalPolicyViolation } from "./proposal-validation.mjs";
import { callQwen } from "./ollama-client.mjs";
const target = "src/app/page.tsx";
const valid = { status: "WAITING_FOR_HUMAN_APPROVAL", target, action: "CREATE_CANDIDATE_ONLY", summary: "Add a comment explaining section order" };
assert.ok(parseProposal(JSON.stringify(valid), target));
assert.ok(parseProposal(JSON.stringify(valid, null, 2), target));
console.log("PASS compact and formatted JSON");
for (const [name, input] of [
  ["trailing source", JSON.stringify(valid) + "\nSOURCE: code"],
  ["fence", "```json\n" + JSON.stringify(valid) + "\n```"],
  ["extra source field", JSON.stringify({ ...valid, source: "code" })],
  ["missing field", JSON.stringify({ target })],
  ["wrong target", JSON.stringify({ ...valid, target: "layout.tsx" })],
  ["wrong action", JSON.stringify({ ...valid, action: "WRITE_FORMAL" })],
  ["null", "null"], ["array", "[]"],
  ["wrong summary type", JSON.stringify({ ...valid, summary: 42 })],
  ["empty summary", JSON.stringify({ ...valid, summary: " " })],
  ["inline JSX", JSON.stringify({ ...valid, summary: "Add <main>" })],
  ["multiline summary", JSON.stringify({ ...valid, summary: "comment\nSOURCE: code" })],
  ["long summary", JSON.stringify({ ...valid, summary: "x".repeat(401) })],
]) {
  assert.equal(parseProposal(input, target), null, name);
}
console.log("PASS rejects malformed JSON, extra/missing fields and invalid values");
assert.ok(proposalPolicyViolation("Add aria-label to main content area"));
assert.equal(proposalPolicyViolation(valid.summary), "");
console.log("PASS scope policy retained");
const config = { model: "qwen3:8b", ollamaUrl: "http://127.0.0.1:11434/api/generate" };
let sent;
const mock = async (url, options) => {
  assert.equal(url, config.ollamaUrl);
  sent = JSON.parse(options.body);
  return { ok: true, json: async () => ({ done: true, response: JSON.stringify(valid) }) };
};
assert.ok(parseProposal(await callQwen(config, "proposal", proposalSchema(target), mock), target));
assert.deepEqual(sent.format, proposalSchema(target));
assert.equal(sent.options.temperature, 0);
assert.equal(sent.stream, false);
console.log("PASS request carries proposal JSON schema");
await callQwen(config, "candidate source", undefined, mock);
assert.equal(Object.hasOwn(sent, "format"), false);
console.log("PASS code generation stays plain text");
await assert.rejects(() => callQwen(config, "proposal", proposalSchema(target), async () => ({ ok: false, status: 400 })), /OLLAMA_HTTP_400/);
await assert.rejects(() => callQwen(config, "proposal", proposalSchema(target), async () => ({ ok: true, json: async () => ({ done: false, response: "{}" }) })), /INCOMPLETE/);
console.log("PASS HTTP and incomplete responses fail closed");
