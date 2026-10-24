// Format is opt-in: code generation and legacy QA remain plain text.
export async function callQwen(config, prompt, format, fetchImpl = fetch) {
  const body = { model: config.model, prompt, stream: false };
  if (format) {
    body.format = format;
    body.options = { temperature: 0 };
  }
  const response = await fetchImpl(config.ollamaUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw new Error(`OLLAMA_HTTP_${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(`OLLAMA_ERROR: ${data.error}`);
  if (typeof data.response !== "string" || data.done !== true) throw new Error("OLLAMA_RESPONSE_INVALID_OR_INCOMPLETE");
  return data.response.trim();
}
