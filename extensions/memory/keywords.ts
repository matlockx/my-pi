// English and German function words and request filler. Search terms are OR-joined,
// so any of these would match nearly every memory and bury the relevant ones.
const STOP_WORDS = new Set([
	"the", "and", "for", "are", "but", "not", "you", "your", "all", "any", "can", "had", "has", "have",
	"her", "his", "how", "its", "our", "out", "was", "were", "who", "why", "what", "when", "where",
	"which", "will", "with", "would", "could", "should", "this", "that", "these", "those", "there",
	"then", "than", "them", "they", "from", "into", "onto", "about", "just", "also", "some", "more",
	"most", "very", "does", "did", "done", "doing", "please", "thanks", "make", "let", "lets", "get",
	"use", "using", "need", "want", "now", "yes", "okay", "here", "via", "per", "may", "might", "must",
	"der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer", "und", "oder",
	"aber", "nicht", "kein", "keine", "ist", "sind", "war", "wird", "werden", "wurde", "hat", "haben",
	"mit", "für", "auf", "aus", "bei", "von", "vom", "zum", "zur", "wie", "was", "wer", "warum",
	"wann", "welche", "welcher", "dass", "auch", "noch", "nur", "schon", "bitte", "danke", "kannst",
	"können", "mach", "mache", "machen", "ich", "wir", "ihr", "sie", "mir", "mich", "uns", "dir", "dich",
	"hier", "jetzt", "dann", "doch", "mal", "nein",
]);

/**
 * Returns the distinct lower-case content words of a prompt in order of first appearance,
 * at most `limit` of them. Words shorter than three characters, stop words and pure
 * numbers are dropped.
 */
export function promptKeywords(prompt: string, limit = 10): string[] {
	const words = new Set<string>();
	for (const word of prompt.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
		if (word.length < 3 || STOP_WORDS.has(word) || /^\p{N}+$/u.test(word)) continue;
		words.add(word);
		if (words.size === limit) break;
	}
	return [...words];
}
