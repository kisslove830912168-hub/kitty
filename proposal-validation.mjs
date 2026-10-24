export function proposalSchema(target) {
  return {
    type: "object", additionalProperties: false,
    required: ["status", "target", "action", "summary"],
    properties: {
      status: { type: "string", enum: ["WAITING_FOR_HUMAN_APPROVAL"] },
      target: { type: "string", enum: [target] },
      action: { type: "string", enum: ["CREATE_CANDIDATE_ONLY"] },
      summary: { type: "string", minLength: 1, maxLength: 400 },
    },
  };
}

export function parseProposal(text, expectedTarget) {
  if (typeof text !== "string") return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const keys = Object.keys(value);
  if (keys.length !== 4 || !["status", "target", "action", "summary"].every((key) => Object.hasOwn(value, key))) return null;
  if (value.status !== "WAITING_FOR_HUMAN_APPROVAL" || value.target !== expectedTarget || value.action !== "CREATE_CANDIDATE_ONLY" || typeof value.summary !== "string") return null;
  const summary = value.summary.trim();
  if (!summary || value.summary.length > 400 || /[<>`\x00-\x1f]/.test(summary)) return null;
  return { summary };
}

// Conservative scope filter, not a semantic correctness guarantee.
export function proposalPolicyViolation(summary) {
  if (/\b(?:data-testid|aria-label|landmark|wrapper|wrap|fragment|props?)\b|<\/?main\b|\bmain\s+(?:tag|element|content|landmark)\b/i.test(summary)) {
    return "PROPOSAL_REQUIRES_UNSUPPORTED_STRUCTURAL_OR_CHILD_CHANGE";
  }
  return "";
}
