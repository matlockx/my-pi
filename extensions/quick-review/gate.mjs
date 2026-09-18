/**
 * Decision logic for the auto quick-review gate, kept free of pi APIs so it is testable.
 */

/**
 * Auto-reviews allowed per user request before the extension stops deciding on its own.
 *
 * The counter is reset by every user-initiated turn, so it bounds one review/fix
 * ping-pong rather than the session: a long session earns a review per request.
 */
export const MAX_AUTO_REVIEWS = 3;

/**
 * Largest number of HIGH/MED findings the agent fixes without asking. Above it the fix
 * turn is a change of its own size, which is the user's call to make.
 */
export const AUTO_FIX_LIMIT = 3;

/**
 * Decides how the findings of a review are followed up.
 *
 * HIGH and MED findings are defects; up to AUTO_FIX_LIMIT of them are fixed without
 * asking. A larger batch is proposed instead, as is a report that carries only LOW
 * findings, which are improvements rather than defects.
 *
 * @param {Array<{severity: "HIGH"|"MED"|"LOW"}>} findings Findings in report order.
 * @returns {{action: "auto"|"ask"|"none", actionable: number, reason: string}} `reason` names the rule that decided, for logging.
 */
export function fixDecision(findings) {
 const list = findings ?? [];
 const actionable = list.filter(
  (f) => f.severity === "HIGH" || f.severity === "MED",
 ).length;

 if (list.length === 0) return { action: "none", actionable, reason: "clean" };
 if (actionable === 0) return { action: "ask", actionable, reason: "low-only" };
 if (actionable > AUTO_FIX_LIMIT)
  return { action: "ask", actionable, reason: "over-limit" };
 return { action: "auto", actionable, reason: "defects" };
}

/**
 * Decides whether a starting agent loop gets the self-review directive in its system prompt.
 *
 * Withheld inside the review/fix cycle, where a turn reviewing itself would nest a review in
 * a review, and while the user has opted out for the session.
 *
 * @param {object} input
 * @param {boolean} [input.disabled] True when the user opted out for this session.
 * @param {"idle"|"reviewing"|"fixing"} [input.phase] Loop the next agent_end belongs to.
 * @returns {boolean} True when the directive is appended.
 */
export function shouldSelfReview({ disabled = false, phase = "idle" } = {}) {
 return !disabled && phase === "idle";
}

/**
 * Decides whether an agent_end should trigger an automatic quick review.
 *
 * @param {object} input
 * @param {string} input.hash Fingerprint of the current uncommitted diff. Empty string means a clean tree.
 * @param {Set<string>} input.reviewed Fingerprints already reviewed in this session.
 * @param {number} input.count Auto-reviews already triggered for the current user request.
 * @param {boolean} [input.edited] True when the tracked tree changed during the finished
 *   turn. Defaults to false, so a caller that omits it never triggers a review.
 * @param {boolean} [input.disabled] True when the user opted out for this session.
 * @returns {{review: boolean, ask: boolean, reason: string}} `ask` requires the user to confirm the review first; `reason` names the rule that decided, for logging.
 */
export function shouldAutoReview({
 hash,
 reviewed,
 count,
 edited = false,
 disabled = false,
}) {
 if (disabled) return { review: false, ask: false, reason: "disabled" };
 if (!hash) return { review: false, ask: false, reason: "clean-tree" };
 if (!edited) return { review: false, ask: false, reason: "no-edits" };
 if (reviewed.has(hash))
  return { review: false, ask: false, reason: "already-reviewed" };
 // DEV-NOTE: past the budget the review is offered rather than dropped. Silence here
 // is the worse failure: the run that has already looped twice is the one worth reading.
 if (count >= MAX_AUTO_REVIEWS)
  return { review: true, ask: true, reason: "budget-exhausted" };
 return { review: true, ask: false, reason: "changed" };
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
 * Locates the review verdict in a finished agent loop.
 *
 * Placement is what tells a self-review from a review turn: a turn asked to review
 * ends on its report, so the verdict is in the last assistant message, while a working
 * turn that reviewed itself ends on the task summary, with the verdict above it. The
 * first case still needs the fix offer; the second has already fixed what it found.
 *
 * @param {Array<{role?: string, content?: unknown}>} messages Messages as delivered by agent_end.
 * @returns {{verdict: "PASS"|"CONCERNS"|"FAIL"|null, placement: "last"|"inline"|"none", text: string}} `text` is the assistant message carrying the verdict, "" when there is none.
 */
export function turnVerdict(messages) {
 const list = messages ?? [];
 const lastAssistant = list.findLastIndex(
  (message) => message?.role === "assistant",
 );

 for (let i = lastAssistant; i >= 0; i--) {
  if (list[i]?.role !== "assistant") continue;
  const text = messageText(list[i]);
  const verdict = parseVerdict(text);
  if (verdict)
   return { verdict, placement: i === lastAssistant ? "last" : "inline", text };
 }

 return { verdict: null, placement: "none", text: "" };
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
 * Reads the working directories a bash command reaches into.
 *
 * Recognises `cd <dir>` and `git -C <dir>`, which is how a turn leaves the session's
 * own directory. Paths are returned verbatim, quotes stripped; a relative one is
 * resolved by the caller against the session directory.
 *
 * ponytail: no shell parsing, a regex over the command text. A `cd` built from a
 * variable or a second `cd` relative to the first is missed; move to a real parser
 * only if that shows up in practice.
 *
 * @param {string} command The bash command line.
 * @returns {string[]} Directory arguments in command order, deduplicated.
 */
export function commandDirs(command) {
 const patterns = [
  /\bcd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g,
  /\bgit\s+-C\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g,
 ];
 const dirs = new Set();
 for (const pattern of patterns) {
  for (const match of (command ?? "").matchAll(pattern)) {
   const dir = match[1].replace(/^["']|["']$/g, "");
   if (dir && !dir.startsWith("-") && dir !== "$" && !dir.includes("$"))
    dirs.add(dir);
  }
 }
 return [...dirs];
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
