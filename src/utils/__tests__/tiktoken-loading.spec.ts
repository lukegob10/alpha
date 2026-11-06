import type { Anthropic } from "@anthropic-ai/sdk"

const { loadBindings, loadVocabulary, constructEncoder, encode } = vi.hoisted(() => {
	const encode = vi.fn(() => new Uint32Array([1, 2]))
	return {
		loadBindings: vi.fn(),
		loadVocabulary: vi.fn(),
		constructEncoder: vi.fn(function () {
			return { encode }
		}),
		encode,
	}
})

const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "Token counting fixture" }]

function bindingsModule() {
	loadBindings()
	return { Tiktoken: constructEncoder }
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => (resolve = done))
	return { promise, resolve }
}

beforeEach(() => {
	vi.resetModules()
	vi.clearAllMocks()
	vi.doMock("tiktoken/lite", bindingsModule)
	vi.doMock("tiktoken/encoders/o200k_base", () => {
		loadVocabulary()
		return { default: { bpe_ranks: "fixture-ranks", special_tokens: {}, pat_str: "fixture-pattern" } }
	})
})

afterEach(() => {
	vi.doUnmock("tiktoken/lite")
	vi.doUnmock("tiktoken/encoders/o200k_base")
})

describe("deferred tokenizer initialization", () => {
	it("keeps startup imports free of tokenizer bindings and vocabulary", async () => {
		await import("../tiktoken")

		expect(loadBindings).not.toHaveBeenCalled()
		expect(loadVocabulary).not.toHaveBeenCalled()
		expect(constructEncoder).not.toHaveBeenCalled()
	})

	it("keeps empty counts free of tokenizer initialization", async () => {
		const { tiktoken } = await import("../tiktoken")

		expect(await tiktoken([])).toBe(0)
		expect(loadBindings).not.toHaveBeenCalled()
		expect(loadVocabulary).not.toHaveBeenCalled()
		expect(constructEncoder).not.toHaveBeenCalled()
	})

	it("shares pending initialization across concurrent counts and reuses the encoder", async () => {
		const started = deferred()
		const ready = deferred()
		vi.doMock("tiktoken/lite", async () => {
			loadBindings()
			started.resolve()
			await ready.promise
			return { Tiktoken: constructEncoder }
		})
		const { tiktoken } = await import("../tiktoken")

		const first = tiktoken(content)
		const second = tiktoken(content)
		await started.promise
		expect(constructEncoder).not.toHaveBeenCalled()
		ready.resolve()

		expect(await Promise.all([first, second])).toEqual([3, 3])
		expect(await tiktoken(content)).toBe(3)
		expect(loadBindings).toHaveBeenCalledOnce()
		expect(loadVocabulary).toHaveBeenCalledOnce()
		expect(constructEncoder).toHaveBeenCalledExactlyOnceWith("fixture-ranks", {}, "fixture-pattern")
		expect(encode).toHaveBeenCalledTimes(3)
		expect(encode).toHaveBeenCalledWith("Token counting fixture", undefined, [])
	})

	it("shares a loading failure and allows a later count to retry", async () => {
		vi.doMock("tiktoken/lite", () => {
			loadBindings()
			throw new Error("Temporary tokenizer load failure")
		})
		const { tiktoken } = await import("../tiktoken")

		const results = await Promise.allSettled([tiktoken(content), tiktoken(content)])
		expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"])
		expect(constructEncoder).not.toHaveBeenCalled()
		expect(loadBindings).toHaveBeenCalledOnce()

		vi.doMock("tiktoken/lite", bindingsModule)
		expect(await tiktoken(content)).toBe(3)
		expect(loadBindings).toHaveBeenCalledTimes(2)
		expect(constructEncoder).toHaveBeenCalledOnce()
	})

	it("allows a later count to retry encoder construction", async () => {
		constructEncoder.mockImplementationOnce(() => {
			throw new Error("Temporary encoder initialization failure")
		})
		const { tiktoken } = await import("../tiktoken")

		await expect(tiktoken(content)).rejects.toThrow("Temporary encoder initialization failure")
		expect(await tiktoken(content)).toBe(3)
		expect(loadBindings).toHaveBeenCalledOnce()
		expect(loadVocabulary).toHaveBeenCalledOnce()
		expect(constructEncoder).toHaveBeenCalledTimes(2)
	})
})
