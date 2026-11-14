/**
 * Appends a section to the system prompt a `before_agent_start` handler receives: an array of
 * blocks under omp, a string under pi. A template string would join omp's array with commas
 * (`</critical>,<project-context>`), so callers return this function's result instead.
 */
export function appendSystemPrompt(base, text) {
	if (Array.isArray(base)) return [...base, text];
	return base ? `${base}\n\n${text}` : text;
}
