/**
 * Decision logic for the auto quick-review gate, kept free of pi APIs so it is testable.
 */

/** Maximum auto-reviews per session, guarding against review/fix ping-pong. */
export const MAX_AUTO_REVIEWS = 3;

/**
 * Decides whether an agent_end should trigger an automatic quick review.
 *
 * @param {object} input
 * @param {string} input.hash Fingerprint of the current uncommitted diff. Empty string means a clean tree.
 * @param {Set<string>} input.reviewed Fingerprints already reviewed in this session.
 * @param {number} input.count Auto-reviews already triggered in this session.
 * @param {boolean} [input.disabled] True when the user opted out for this session.
 * @returns {{review: boolean, reason: string}} `reason` names the rule that decided, for logging.
 */
export function shouldAutoReview({ hash, reviewed, count, disabled = false }) {
 if (disabled) return { review: false, reason: "disabled" };
 if (!hash) return { review: false, reason: "clean-tree" };
 if (reviewed.has(hash)) return { review: false, reason: "already-reviewed" };
 if (count >= MAX_AUTO_REVIEWS)
  return { review: false, reason: "budget-exhausted" };
 return { review: true, reason: "changed" };
}

/**
 * Concatenates the text blocks of the last assistant message in a turn.
 *
 * @param {Array<{role?: string, content?: unknown}>} messages Messages as delivered by agent_end.
 * @returns {string} The assistant text, or "" when the turn produced none.
 */
export function lastAssistantText(messages) {
 for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
  const message = messages[i];
  if (message?.role !== "assistant") continue;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
   .filter((block) => block?.type === "text" && typeof block.text === "string")
   .map((block) => block.text)
   .join("\n");
 }
 return "";
}

/**
 * Reads the verdict out of a quick-review report.
 *
 * @param {string} text The assistant's review output.
 * @returns {"PASS"|"CONCERNS"|"FAIL"|null} The verdict, or null when the report carries no verdict line.
 */
export function parseVerdict(text) {
 const match =
  /^\s*(?:\*\*)?VERDICT(?:\*\*)?\s*:\s*(PASS|CONCERNS|FAIL)\b/im.exec(
   text ?? "",
  );
 return match
  ? /** @type {"PASS"|"CONCERNS"|"FAIL"} */ (match[1].toUpperCase())
  : null;
}

/**
 * Strips YAML frontmatter from a prompt file so the body can be sent as a user message.
 *
 * @param {string} markdown Raw prompt file contents.
 * @returns {string} The body without frontmatter, trimmed.
 */
export function promptBody(markdown) {
 const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(markdown);
 return (match ? markdown.slice(match[0].length) : markdown).trim();
}
