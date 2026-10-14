import { formatAnswerScalar } from "./format-answer.js";
import type { QuestionAnswer, QuestionnaireResult, QuestionParams } from "./types.js";

export const DECLINE_MESSAGE = "User declined to answer questions";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";
/**
 * Rides before the suffix when any answer was typed. A typed answer is often a
 * question back ("what does this mean?"); without this, models resolve it only in
 * their reasoning and re-ask, so the user never sees the explanation.
 */
export const TYPED_ANSWER_NOTE =
	"Some answers were typed by the user instead of picked from your options. If a typed answer asks a question or asks you to explain something, answer it in visible message text, not only in your thinking, before you continue or ask more questions.";

/**
 * Map a `QuestionnaireResult` (or null/cancelled) to the LLM-facing tool envelope.
 * Pure of `(result, params)`; cancelled and "no segments" both fall to `DECLINE_MESSAGE`
 * so the model sees a single canonical "didn't answer" signal regardless of why.
 * "No segments" means no answers AND no global note — the `global note:` segment is
 * pushed before the zero-segments check, so a note-bearing submit with zero answers
 * still yields the answered envelope.
 */
export function buildQuestionnaireResponse(result: QuestionnaireResult | null | undefined, params: QuestionParams) {
	if (!result || result.cancelled) {
		// Decline text stays canonical even when a global note rides the cancelled result;
		// the note survives in `details` (like partial `answers`) for replay consumers.
		return buildToolResult(DECLINE_MESSAGE, {
			answers: result?.answers ?? [],
			cancelled: true,
			...(result?.globalNote && result.globalNote.length > 0 ? { globalNote: result.globalNote } : {}),
		});
	}
	const segments: string[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const a = result.answers.find((x) => x.questionIndex === i);
		if (a) segments.push(buildAnswerSegment(a));
	}
	// Global note rides after the per-question segments: raw multiline echo (no
	// reformatting), trailing period mirroring `buildAnswerSegment`'s shape.
	if (result.globalNote && result.globalNote.length > 0) {
		segments.push(`global note: ${result.globalNote}.`);
	}
	if (segments.length === 0) {
		return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
	}
	const typed = result.answers.some((a) => a.kind === "custom" && !!a.answer);
	const suffix = typed ? `${TYPED_ANSWER_NOTE} ${ENVELOPE_SUFFIX}` : ENVELOPE_SUFFIX;
	return buildToolResult(`${ENVELOPE_PREFIX} ${segments.join(" ")} ${suffix}`, result);
}

/**
 * Format a single answer segment for the envelope. Pure of `a`. The `"Q"="A"` shape and
 * the optional `selected preview:` / `user notes:` suffixes are pinned by envelope tests.
 */
export function buildAnswerSegment(a: QuestionAnswer): string {
	const parts: string[] = [`"${a.question}"="${formatAnswerScalar(a, "envelope")}"`];
	if (a.preview && a.preview.length > 0) parts.push(`selected preview: ${a.preview}`);
	if (a.notes && a.notes.length > 0) parts.push(`user notes: ${a.notes}`);
	return `${parts.join(". ")}.`;
}

export function buildToolResult(text: string, details: QuestionnaireResult) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}
