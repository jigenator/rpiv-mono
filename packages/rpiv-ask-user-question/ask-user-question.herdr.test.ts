import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import type { AskUserQuestionConfig } from "./config.js";
import type { QuestionnaireResult } from "./tool/types.js";

const config = vi.hoisted(() => ({ value: {} as AskUserQuestionConfig }));
vi.mock("./config.js", async (original) => ({
	...(await original<typeof import("./config.js")>()),
	loadConfig: () => config.value,
}));
const params = {
	questions: [{ question: "Private question", header: "Pick", options: [{ label: "A" }, { label: "B" }] }],
};
const cancelled = { answers: [], cancelled: true };

beforeEach(() => {
	config.value = {};
	vi.stubEnv("HERDR_ENV", "1");
	vi.stubEnv("HERDR_PANE_ID", "test:pane");
	vi.stubEnv("HERDR_SOCKET_PATH", "/tmp/not-a-real-herdr.sock");
	vi.stubEnv("HERDR_BIN_PATH", "/mock/herdr");
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

function setup(custom: ExtensionUIContext["custom"], mode = "tui") {
	const mock = createMockPi();
	registerAskUserQuestionTool(mock.pi);
	const tool = mock.captured.tools.get("ask_user_question")!;
	const ctx = createMockCtx({ hasUI: true, mode, ui: { custom } });
	const run = (signal?: AbortSignal) => tool.execute("tc", params, signal, undefined, ctx);
	const lifecycle = async (name: string) => {
		for (const handler of mock.captured.events.get(name) ?? []) await handler({}, ctx);
	};
	const edges = (channel = "herdr:blocked") => mock.captured.eventsEmitted.get(channel) ?? [];
	return { ...mock, ctx, tool, run, lifecycle, edges };
}

/** Exercises the real questionnaire component through the host's done contract. */
function customHost() {
	let component: { handleInput?: (data: string) => void } | undefined;
	const done = vi.fn();
	const custom: ExtensionUIContext["custom"] = (factory) =>
		new Promise((resolve, reject) => {
			const finish = (value: unknown) => {
				done(value);
				resolve(value as never);
			};
			Promise.resolve(
				factory(
					{ requestRender: vi.fn(), terminal: { columns: 120, rows: 24 } } as never,
					{ fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s } as never,
					getKeybindings() as never,
					finish,
				),
			).then((c) => {
				component = c;
			}, reject);
		});
	return { custom, done, ready: () => !!component, key: (key: string) => component?.handleInput?.(key) };
}

function deferredCustom() {
	let resolve!: (result: QuestionnaireResult) => void;
	const custom = vi.fn(
		() =>
			new Promise<QuestionnaireResult>((r) => {
				resolve = r;
			}),
	) as unknown as ExtensionUIContext["custom"];
	return { custom, finish: (result = cancelled) => resolve(result), resolver: () => resolve };
}

describe("questionnaire Herdr lifecycle", () => {
	it.each(["answer", "escape", "abort"])("default-on: real component %s closes exactly one lease", async (action) => {
		const host = customHost();
		const test = setup(host.custom);
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const result = test.run(controller.signal);
		await vi.waitFor(() => expect(host.ready()).toBe(true));
		expect(test.edges()).toEqual([{ active: true }]);
		if (action === "abort") controller.abort();
		else host.key(action === "answer" ? "\r" : "\x1b");
		const response = await result;
		expect(response.details).toMatchObject({ cancelled: action !== "answer" });
		expect(host.done).toHaveBeenCalledOnce();
		expect(test.edges()).toEqual([{ active: true }, { active: false }]);
		expect(test.edges("rpiv:ask-user:blocked")).toEqual([{ active: true }, { active: false }]);
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		await test.lifecycle("session_shutdown");
		expect(JSON.stringify(vi.mocked(test.pi.exec).mock.calls)).not.toContain("Private question");
	});

	it("UI rejection releases both owned signals", async () => {
		const test = setup(
			vi.fn(async () => {
				throw new Error("UI failed");
			}),
		);
		await expect(test.run()).rejects.toThrow("UI failed");
		expect(test.edges()).toEqual([{ active: true }, { active: false }]);
		await test.lifecycle("session_shutdown");
	});

	it("pre-abort, no UI and invalid params never open a lease or UI", async () => {
		const custom = vi.fn();
		const test = setup(custom);
		const controller = new AbortController();
		controller.abort();
		await test.run(controller.signal);
		await test.tool.execute("tc", params, undefined, undefined, createMockCtx({ hasUI: false, mode: "tui" }));
		await test.tool.execute("tc", { questions: [] }, undefined, undefined, test.ctx);
		expect(custom).not.toHaveBeenCalled();
		expect(test.edges()).toEqual([]);
		expect(test.edges("rpiv:ask-user:blocked")).toEqual([]);
		expect(test.pi.exec).not.toHaveBeenCalled();
	});

	it("opt-out preserves public events and config changes cannot unbalance an open wait", async () => {
		config.value = { herdrStatus: false };
		const host = deferredCustom();
		const test = setup(host.custom);
		const first = test.run();
		await vi.waitFor(() => expect(host.custom).toHaveBeenCalledOnce());
		config.value = {};
		host.finish();
		await first;
		expect(test.edges()).toEqual([]);
		expect(test.edges("rpiv:ask-user:blocked")).toEqual([{ active: true }, { active: false }]);
		const second = test.run();
		await vi.waitFor(() => expect(host.custom).toHaveBeenCalledTimes(2));
		config.value = { herdrStatus: false };
		host.finish();
		await second;
		expect(test.edges()).toEqual([{ active: true }, { active: false }]);
		await test.lifecycle("session_shutdown");
	});

	it.each(["sdk", "rpc"])("no Herdr work in %s mode", async (mode) => {
		const test = setup(vi.fn(async () => cancelled) as never, mode);
		await test.run();
		expect(test.edges()).toEqual([]);
		expect(test.pi.exec).not.toHaveBeenCalled();
	});

	it.each(["session_shutdown", "session_start"])(
		"%s cancels owned waits; late completion cannot touch a new lease",
		async (event) => {
			const host = deferredCustom();
			const test = setup(host.custom);
			const first = test.run();
			await vi.waitFor(() => expect(host.custom).toHaveBeenCalledOnce());
			const finishOld = host.resolver();
			// Keep the old resolver before the second invocation replaces it.
			const oldPromise = vi.mocked(host.custom).mock.results[0].value;
			await test.lifecycle(event);
			expect((await first).details).toMatchObject({ cancelled: true });
			const second = test.run();
			await vi.waitFor(() => expect(host.custom).toHaveBeenCalledTimes(2));
			finishOld(cancelled);
			await oldPromise;
			expect(test.edges()).toEqual([{ active: true }, { active: false }, { active: true }]);
			await test.lifecycle("session_shutdown");
			await second;
			expect(test.edges()).toEqual([{ active: true }, { active: false }, { active: true }, { active: false }]);
		},
	);

	it("shutdown uses the real custom UI done callback, not just a badge reset", async () => {
		const host = customHost();
		const test = setup(host.custom);
		const pending = test.run();
		await vi.waitFor(() => expect(host.ready()).toBe(true));
		await test.lifecycle("session_shutdown");
		await pending;
		expect(host.done).toHaveBeenCalledOnce();
		host.key("\r"); // late component callback is inert
		expect(host.done).toHaveBeenCalledOnce();
	});

	it("a delayed SDK factory after abort closes without constructing or reviving a questionnaire", async () => {
		let factory!: Parameters<ExtensionUIContext["custom"]>[0];
		const custom = vi.fn((value) => {
			factory = value;
			return new Promise(() => {});
		});
		const test = setup(custom as ExtensionUIContext["custom"]);
		const controller = new AbortController();
		const result = test.run(controller.signal);
		await vi.waitFor(() => expect(custom).toHaveBeenCalledOnce());
		controller.abort();
		await result;
		const done = vi.fn();
		const component = await factory(undefined as never, undefined as never, undefined as never, done);
		expect(component.render(80)).toEqual([]);
		expect(done).toHaveBeenCalledExactlyOnceWith(cancelled);
		expect(test.edges()).toEqual([{ active: true }, { active: false }]);
		await test.lifecycle("session_shutdown");
	});

	it("a hung transport never blocks an answer or bounded shutdown", async () => {
		vi.useFakeTimers();
		try {
			const test = setup(vi.fn(async () => cancelled) as never);
			vi.mocked(test.pi.exec).mockImplementation(() => new Promise(() => {}));
			expect((await test.run()).details).toMatchObject({ cancelled: true });
			const shutdown = test.lifecycle("session_shutdown");
			await vi.advanceTimersByTimeAsync(1500);
			await shutdown;
			expect(test.edges()).toEqual([{ active: true }, { active: false }]);
			expect(test.pi.exec).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("legacy deferred RPC fallback keeps the public bracket until the last dialog resolves", async () => {
		const test = setup(vi.fn(async () => undefined) as never, "legacy");
		let finish!: (answer: string) => void;
		const select = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					finish = resolve;
				}),
		);
		test.ctx.ui.select = select;
		const pending = test.run();
		await vi.waitFor(() => expect(select).toHaveBeenCalledOnce());
		expect(test.edges("rpiv:ask-user:blocked")).toEqual([{ active: true }]);
		finish("1. A");
		await pending;
		expect(test.edges("rpiv:ask-user:blocked")).toEqual([{ active: true }, { active: false }]);
		expect(test.edges()).toEqual([]);
	});
});
