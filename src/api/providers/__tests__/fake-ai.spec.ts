import type { ApiHandlerOptions } from "../../../shared/api"
import type { ApiStream } from "../../transform/stream"
import { FakeAIHandler } from "../fake-ai"

const makeFakeAI = (id: string, modelId: string) => {
	const fakeAI = {
		id,
		removeFromCache: undefined as (() => void) | undefined,
		async *createMessage(): ApiStream {
			yield { type: "text", text: modelId }
		},
		getModel: () => ({
			id: modelId,
			info: { contextWindow: 1_000, supportsPromptCache: false },
		}),
		countTokens: async () => 1,
		completePrompt: async () => modelId,
	}
	return fakeAI
}

const options = (fakeAi: unknown) => ({ fakeAi }) as ApiHandlerOptions

describe("FakeAIHandler registration", () => {
	it("rejects a serialized stub without poisoning a later executable registration", () => {
		expect(() => new FakeAIHandler(options({ id: "late-registration" }))).toThrow(
			"Fake AI implementation late-registration is not registered",
		)

		const executable = makeFakeAI("late-registration", "working-model")
		const handler = new FakeAIHandler(options(executable))
		expect(handler.getModel().id).toBe("working-model")
		executable.removeFromCache?.()
	})

	it("rehydrates a serialized configuration from the registered implementation", () => {
		const executable = makeFakeAI("rehydration", "cached-model")
		new FakeAIHandler(options(executable))

		const rehydrated = new FakeAIHandler(options({ id: "rehydration" }))
		expect(rehydrated.getModel().id).toBe("cached-model")
		executable.removeFromCache?.()
	})

	it("replaces a same-id implementation without letting the old removal callback evict it", () => {
		const first = makeFakeAI("replacement", "first-model")
		const second = makeFakeAI("replacement", "second-model")
		new FakeAIHandler(options(first))
		new FakeAIHandler(options(second))

		first.removeFromCache?.()
		expect(new FakeAIHandler(options({ id: "replacement" })).getModel().id).toBe("second-model")
		second.removeFromCache?.()
	})
})
