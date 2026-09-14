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
 * @param {boolean} [input.edited] True when the tracked tree changed during the finished
 *   turn. Defaults to false, so a caller that omits it never triggers a review.
 * @param {boolean} [input.disabled] True when the user opted out for this session.
 * @returns {{review: boolean, reason: string}} `reason` names the rule that decided, for logging.
 */
export function shouldAutoReview({
 hash,
 reviewed,
 count,
 edited = false,
 disabled = false,
}) {
 if (disabled) return { review: false, reason: "disabled" };
 if (!hash) return { review: false, reason: "clean-tree" };
 if (!edited) return { review: false, reason: "no-edits" };
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
  if (messages[i]?.role === "assistant") return messageText(messages[i]);
 }
 return "";
}

/**
 * Concatenates the text blocks of one message.
 *
 * @param {{content?: unknown}} message A message with string or block content.
 * @returns {string} The text, or "" when the message carries none.
 */
export function messageText(message) {
 const content = message?.content;
 if (typeof content === "string") return content;
 if (!Array.isArray(content)) return "";
 return content
  .filter((block) => block?.type === "text" && typeof block.text === "string")
  .map((block) => block.text)
  .join("\n");
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
 * Fingerprints the tracked changes in a `git status --porcelain` listing.
 *
 * Untracked entries are ignored, so a stray download in the working tree does not
 * look like work to review.
 *
 * @param {string} status Output of `git status --porcelain`.
 * @returns {string} The tracked status lines, or "" when none remain.
 */
export function trackedStatus(status) {
 return (status ?? "")
  .split("\n")
  .filter((line) => line.trim() && !line.startsWith("??"))
  .join("\n");
}

/**
 * Reads the finding lines out of a quick-review report.
 *
 * Matches the report format `<SEVERITY> <file>:<line> — <finding> → <fix>`, with or
 * without surrounding markdown emphasis and list markers. Only the `## Findings`
 * section is scanned, so prose elsewhere in the report cannot produce a finding.
 * `finding` and `fix` are split on the arrow; `fix` is "" when the line carries none.
 *
 * @param {string} text The assistant's review output.
 * @returns {Array<{severity: "HIGH"|"MED"|"LOW", location: string, finding: string, fix: string}>} Findings in report order.
 */
export function parseFindings(text) {
 const pattern =
  /^[\s>*-]*(?:\*\*)?(HIGH|MED|LOW)(?:\*\*)?\s+`?([^\s`]+?)`?\s+[—–-]\s+(.+)$/gim;
 const findings = [];
 for (const match of findingsSection(text ?? "").matchAll(pattern)) {
  const [finding, fix = ""] = match[3].split(/\s*(?:→|->)\s*/, 2);
  findings.push({
   severity: /** @type {"HIGH"|"MED"|"LOW"} */ (match[1].toUpperCase()),
   location: match[2],
   finding: finding.trim(),
   fix: fix.trim(),
  });
 }
 return findings;
}

/**
 * Returns the body of the `## Findings` section, or the whole text when the report
 * carries no such heading.
 *
 * @param {string} text The assistant's review output.
 * @returns {string} The section body.
 */
function findingsSection(text) {
 const start = /^#{1,6}\s*Findings\s*$/im.exec(text);
 if (!start) return text;
 const body = text.slice(start.index + start[0].length);
 const end = /^#{1,6}\s+\S/m.exec(body);
 return end ? body.slice(0, end.index) : body;
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
