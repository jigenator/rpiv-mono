import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ASK_USER_BLOCKED_EVENT } from "./events.js";
import type { QuestionnaireResult } from "./tool/types.js";

export const cancelledQuestionnaire = (): QuestionnaireResult => ({ answers: [], cancelled: true });

/** One owned wait: actual abort, reset and late completion all converge here. */
export function createQuestionWait(pi: ExtensionAPI, signal: AbortSignal | undefined, releaseHerdr: () => void) {
	const controller = new AbortController();
	let closed = false;
	let closeUI: (() => void) | undefined;
	let resolveCancelled!: (result: QuestionnaireResult) => void;
	const cancelled = new Promise<QuestionnaireResult>((resolve) => {
		resolveCancelled = resolve;
	});

	function release(): void {
		if (closed) return;
		closed = true;
		signal?.removeEventListener("abort", cancel);
		closeUI = undefined;
		releaseHerdr();
		pi.events.emit(ASK_USER_BLOCKED_EVENT, { active: false });
	}

	function cancel(): void {
		if (closed) return;
		try {
			controller.abort();
			closeUI?.();
		} finally {
			resolveCancelled(cancelledQuestionnaire());
			release();
		}
	}

	signal?.addEventListener("abort", cancel, { once: true });
	if (signal?.aborted) cancel();
	return {
		signal: controller.signal,
		cancelled,
		cancel,
		release,
		bindUI(done: (result: QuestionnaireResult) => void): (result: QuestionnaireResult) => void {
			let finished = false;
			const finish = (result: QuestionnaireResult) => {
				if (finished || (closed && !controller.signal.aborted)) return;
				finished = true;
				closeUI = undefined;
				done(result);
			};
			closeUI = () => finish(cancelledQuestionnaire());
			if (controller.signal.aborted) closeUI();
			return finish;
		},
	};
}
