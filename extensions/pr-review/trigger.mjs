// Pure helpers of the pr-review extension, kept apart from index.ts so node:test covers them.

const PR_URL = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;
const REVIEW = /\breview(?:ing)?\b/i;

/**
 * Returns the GitHub pull request URLs of a prompt that asks for a review, normalised to
 * https://github.com/<owner>/<repo>/pull/<n> and without duplicates. Empty when the prompt
 * has no review request or no pull request link.
 */
export function prReviewUrls(prompt) {
	if (!REVIEW.test(prompt)) return [];
	const urls = new Set();
	for (const [, owner, repo, number] of prompt.matchAll(PR_URL)) {
		urls.add(`https://github.com/${owner}/${repo}/pull/${number}`);
	}
	return [...urls];
}

/** Returns the system prompt section that makes the pr-review skill binding for urls. */
export function reviewInstruction(urls, skill) {
	return [
		"## PR review",
		"",
		`The user asked for a review of ${urls.join(", ")}. Follow the pr-review skill below for it; it is already loaded, do not read it again.`,
		"",
		skill.replace(/^---\n[\s\S]*?\n---\n/, "").trim(),
	].join("\n");
}
