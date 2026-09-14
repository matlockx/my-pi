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
 * Strips YAML frontmatter from a prompt file so the body can be sent as a user message.
 *
 * @param {string} markdown Raw prompt file contents.
 * @returns {string} The body without frontmatter, trimmed.
 */
export function promptBody(markdown) {
 const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(markdown);
 return (match ? markdown.slice(match[0].length) : markdown).trim();
}
