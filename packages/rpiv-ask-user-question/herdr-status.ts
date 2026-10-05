import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const HERDR_STATUS_TTL_MS = 30_000;
export const HERDR_STATUS_REFRESH_MS = 10_000;
const EXEC_TIMEOUT_MS = 1000;

/** Presentation only. Herdr's managed bridge remains the semantic state authority. */
export function createHerdrQuestionStatus(pi: ExtensionAPI) {
	// Runtime-unique sources prevent an old extension's delayed clear from erasing
	// a new runtime's label on reload. No token/summary/title fields are owned here.
	const source = `rpiv:ask-user-question:${randomUUID()}`;
	let count = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let queued: boolean | undefined;
	let draining: Promise<void> | undefined;
	let sequence = 0;
	let target: { binary: string; pane: string } | undefined;

	async function drain(): Promise<void> {
		while (queued !== undefined && target) {
			const active = queued;
			queued = undefined;
			const args = [
				"pane",
				"report-metadata",
				target.pane,
				"--source",
				source,
				"--agent",
				"pi",
				"--applies-to-source",
				"herdr:pi",
				"--seq",
				String(++sequence),
				...(active
					? ["--state-label", "blocked=question", "--ttl-ms", String(HERDR_STATUS_TTL_MS)]
					: ["--clear-state-labels"]),
			];
			try {
				// argv only, inherited pane socket environment; never shell interpolation.
				// These source-scoped patches are idempotent. A later desired state or
				// TTL refresh supersedes failed/ambiguous writes with a higher sequence.
				await pi.exec(target.binary, args, { timeout: EXEC_TIMEOUT_MS });
			} catch {
				// Best effort: transport must never fail or hold up the questionnaire.
			}
		}
	}

	function queue(active: boolean): void {
		queued = active;
		if (!draining) {
			draining = drain().finally(() => {
				draining = undefined;
				if (queued !== undefined) queue(queued);
			});
		}
	}

	return {
		acquire(ctx: ExtensionContext, enabled: boolean): () => void {
			const { HERDR_ENV, HERDR_PANE_ID, HERDR_SOCKET_PATH, HERDR_BIN_PATH } = process.env;
			if (
				!enabled ||
				!ctx.hasUI ||
				ctx.mode !== "tui" ||
				HERDR_ENV !== "1" ||
				!HERDR_PANE_ID?.trim() ||
				!HERDR_SOCKET_PATH?.trim() ||
				(process.platform !== "win32" && !isAbsolute(HERDR_SOCKET_PATH))
			)
				return () => {};

			target ??= { binary: HERDR_BIN_PATH?.trim() || "herdr", pane: HERDR_PANE_ID };
			count++;
			pi.events.emit("herdr:blocked", { active: true });
			if (count === 1) {
				queue(true);
				timer = setInterval(() => queue(true), HERDR_STATUS_REFRESH_MS);
				timer.unref?.();
			}
			let released = false;
			return () => {
				if (released) return;
				released = true;
				pi.events.emit("herdr:blocked", { active: false });
				if (--count === 0) {
					clearInterval(timer);
					timer = undefined;
					queue(false);
				}
			};
		},
		/** Pi owns process termination. Even a stuck exec must not hold shutdown. */
		async flush(): Promise<void> {
			if (!draining) return;
			let deadline: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					(async () => {
						while (draining) await draining;
					})(),
					new Promise<void>((resolve) => {
						deadline = setTimeout(resolve, 1500);
					}),
				]);
			} finally {
				clearTimeout(deadline);
			}
		},
	};
}
