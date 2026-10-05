import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHerdrQuestionStatus, HERDR_STATUS_REFRESH_MS, HERDR_STATUS_TTL_MS } from "./herdr-status.js";

const ctx = createMockCtx({ hasUI: true, mode: "tui" });
const ok = { stdout: "", stderr: "", code: 0, killed: false };

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("HERDR_ENV", "1");
	vi.stubEnv("HERDR_PANE_ID", "test:pane");
	vi.stubEnv("HERDR_SOCKET_PATH", "/tmp/not-a-real-herdr.sock");
	vi.stubEnv("HERDR_BIN_PATH", "/mock/Herdr App/herdr");
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

function setup() {
	const mock = createMockPi();
	return { ...mock, status: createHerdrQuestionStatus(mock.pi), exec: vi.mocked(mock.pi.exec) };
}

describe("Herdr question presentation leases", () => {
	it("has no registration side effects; only owns blocked label and guarded runtime source", async () => {
		const { pi, status, exec } = setup();
		expect(exec).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		const release = status.acquire(ctx, true);
		await status.flush();
		const args = exec.mock.calls[0][1];
		expect(exec.mock.calls[0][0]).toBe("/mock/Herdr App/herdr");
		expect(exec.mock.calls[0][2]).toEqual({ timeout: 1000 });
		expect(args).toEqual([
			"pane",
			"report-metadata",
			"test:pane",
			"--source",
			expect.stringMatching(/^rpiv:ask-user-question:[\w-]+$/),
			"--agent",
			"pi",
			"--applies-to-source",
			"herdr:pi",
			"--seq",
			"1",
			"--state-label",
			"blocked=question",
			"--ttl-ms",
			String(HERDR_STATUS_TTL_MS),
		]);
		release();
		release();
		await status.flush();
		expect(exec.mock.calls[1][1]).toEqual([...args.slice(0, 10), "2", "--clear-state-labels"]);
		expect(pi.events.emit).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		["HERDR_ENV", "0"],
		["HERDR_PANE_ID", " "],
		["HERDR_SOCKET_PATH", ""],
	])("does nothing without pane context: %s", async (name, value) => {
		vi.stubEnv(name, value);
		const { status, exec, pi } = setup();
		status.acquire(ctx, true)();
		await status.flush();
		expect(exec).not.toHaveBeenCalled();
		expect(pi.events.emit).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does nothing for opt-out, no UI, RPC, SDK or unadvertised mode", () => {
		const { status, exec, pi } = setup();
		status.acquire(ctx, false)();
		for (const mode of ["rpc", "sdk", undefined]) status.acquire(createMockCtx({ hasUI: true, mode }), true)();
		status.acquire(createMockCtx({ mode: "tui", hasUI: false }), true)();
		expect(exec).not.toHaveBeenCalled();
		expect(pi.events.emit).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("refreshes long waits, keeps question for overlap, and stops on final release", async () => {
		const { status, exec, captured } = setup();
		const first = status.acquire(ctx, true);
		const second = status.acquire(ctx, true);
		await status.flush();
		first();
		first();
		await vi.advanceTimersByTimeAsync(HERDR_STATUS_REFRESH_MS * 4);
		expect(exec).toHaveBeenCalledTimes(5);
		expect(exec.mock.calls.every(([, args]) => args.includes("blocked=question"))).toBe(true);
		second();
		await status.flush();
		await vi.advanceTimersByTimeAsync(HERDR_STATUS_TTL_MS * 2);
		expect(exec).toHaveBeenCalledTimes(6);
		expect(captured.eventsEmitted.get("herdr:blocked")).toEqual([
			{ active: true },
			{ active: true },
			{ active: false },
			{ active: false },
		]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("serializes delayed set/clear and coalesces refreshes without stale revival", async () => {
		const { status, exec } = setup();
		let finish!: (value: typeof ok) => void;
		exec.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const release = status.acquire(ctx, true);
		await vi.advanceTimersByTimeAsync(HERDR_STATUS_REFRESH_MS * 3);
		release();
		expect(exec).toHaveBeenCalledTimes(1);
		finish(ok);
		await status.flush();
		expect(exec).toHaveBeenCalledTimes(2);
		expect(exec.mock.calls[1][1].at(-1)).toBe("--clear-state-labels");
	});

	it("an old close cannot clear a newer wait; reload sources are distinct", async () => {
		const { status, exec } = setup();
		const first = status.acquire(ctx, true);
		await status.flush();
		let finish!: (value: typeof ok) => void;
		exec.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		first(); // clear is in flight
		const second = status.acquire(ctx, true);
		first();
		finish(ok);
		await status.flush();
		expect(exec.mock.calls[2][1]).toContain("blocked=question");
		const other = setup();
		const otherRelease = other.status.acquire(ctx, true);
		expect(other.exec.mock.calls[0][1][4]).not.toBe(exec.mock.calls[0][1][4]);
		second();
		otherRelease();
		await Promise.all([status.flush(), other.status.flush()]);
	});

	it.each(["throw", "nonzero", "killed"])(
		"transport %s is nonfatal and does not prevent the final clear",
		async (failure) => {
			const { status, exec } = setup();
			if (failure === "throw") exec.mockRejectedValueOnce(new Error("offline"));
			else exec.mockResolvedValueOnce({ ...ok, code: 1, killed: failure === "killed" });
			const release = status.acquire(ctx, true);
			await status.flush();
			release();
			await status.flush();
			expect(exec.mock.calls.at(-1)?.[1]).toContain("--clear-state-labels");
		},
	);

	it("bounds shutdown when Pi exec never settles without starting a second process", async () => {
		const { status, exec, captured } = setup();
		exec.mockImplementation(() => new Promise(() => {}));
		const release = status.acquire(ctx, true);
		await vi.advanceTimersByTimeAsync(HERDR_STATUS_REFRESH_MS * 2);
		release();
		release();
		const flush = status.flush();
		await vi.advanceTimersByTimeAsync(1500);
		await flush;
		expect(exec).toHaveBeenCalledOnce();
		expect(captured.eventsEmitted.get("herdr:blocked")).toEqual([{ active: true }, { active: false }]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("leaves other producers blocked and follows current activity rather than restoring old state", async () => {
		let count = 1; // unrelated producer
		let working = true;
		const state = () => (count ? "blocked" : working ? "working" : "idle");
		const { pi } = createMockPi({
			events: {
				emit: (_name, data) => {
					count += (data as { active: boolean }).active ? 1 : -1;
				},
				on: () => () => {},
			},
		});
		const status = createHerdrQuestionStatus(pi);
		const release = status.acquire(ctx, true);
		working = false;
		release();
		release();
		expect(count).toBe(1);
		expect(state()).toBe("blocked");
		count--;
		expect(state()).toBe("idle");
		working = true;
		const next = status.acquire(ctx, true);
		next();
		expect(state()).toBe("working");
		await status.flush();
	});
});
