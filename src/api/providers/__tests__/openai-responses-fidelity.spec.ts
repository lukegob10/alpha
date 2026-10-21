import { OpenAiHandler } from "../openai"
import { AgentResponseAccumulator } from "../../../core/agent/AgentResponseAccumulator"
import type { ApiStreamChunk } from "../../transform/stream"

const { responsesCreate } = vi.hoisted(() => ({ responsesCreate: vi.fn() }))

vi.mock("openai", () => {
	const constructor = vi.fn(function () {
		return { responses: { create: responsesCreate } }
	})
	return { default: constructor, AzureOpenAI: constructor }
})

type TextKind = "output_text" | "refusal"

function part(text: string, kind: TextKind = "output_text") {
	return kind === "output_text" ? { type: kind, text, annotations: [] } : { type: kind, refusal: text }
}

function message(text: string, kind: TextKind = "output_text") {
	return {
		type: "message",
		id: "msg_fidelity",
		role: "assistant",
		status: "completed",
		phase: "final_answer",
		content: [part(text, kind)],
	}
}

function delta(text: string, kind: TextKind = "output_text", contentIndex = 0, outputIndex = 0) {
	return {
		type: kind === "output_text" ? "response.output_text.delta" : "response.refusal.delta",
		item_id: "msg_fidelity",
		output_index: outputIndex,
		content_index: contentIndex,
		delta: text,
	}
}

function done(item: unknown, outputIndex = 0) {
	return { type: "response.output_item.done", output_index: outputIndex, item }
}

function completed(output: unknown[]) {
	return {
		type: "response.completed",
		response: { id: "resp_fidelity", status: "completed", output, end_turn: false, usage: null },
	}
}

function mockStream(...events: unknown[]) {
	responsesCreate.mockResolvedValueOnce({
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event
		},
	})
}

async function consume() {
	const handler = new OpenAiHandler({
		openAiApiKey: "fixture-key",
		openAiModelId: "gpt-6.1-sol",
		openAiBaseUrl: "https://api.openai.com/v1",
	})
	const chunks: ApiStreamChunk[] = []
	const accumulator = new AgentResponseAccumulator()
	let failure: unknown
	try {
		for await (const chunk of handler.createMessage("system", [])) {
			chunks.push(chunk)
			await accumulator.add(chunk)
		}
	} catch (error) {
		failure = error
	}
	return {
		chunks,
		failure,
		canonical: await accumulator.finish(undefined, failure ? { status: "failed", retryable: false } : undefined),
		handler,
	}
}

describe("OpenAI Responses completed text fidelity", () => {
	beforeEach(() => {
		responsesCreate.mockReset()
		vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => vi.restoreAllMocks())

	it.each(
		(["output_text", "refusal"] as const).flatMap((kind) =>
			["done", "repeated_done", "completed", "completed_only"].map((source) => ({ kind, source })),
		),
	)("appends the missing $kind suffix first supplied by $source once", async ({ kind, source }) => {
		const partial = message("Hello", kind)
		const full = message("Hello world", kind)
		const receipts =
			source === "done"
				? [done(full)]
				: source === "repeated_done"
					? [done(partial), done(full), done(full)]
					: source === "completed"
						? [done(partial)]
						: []
		mockStream(delta("Hel", kind), delta("lo", kind), ...receipts, completed([full]))

		const { chunks, failure, canonical, handler } = await consume()
		expect(failure).toBeUndefined()
		expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text)).toEqual([
			"Hel",
			"lo",
			" world",
		])
		expect(canonical.text).toBe("Hello world")
		expect(canonical.items.filter((item) => item.type === "text")).toEqual(
			["Hel", "lo", " world"].map((text) => ({
				type: "text",
				text,
				id: "msg_fidelity",
				phase: "final_answer",
				outputIndex: 0,
			})),
		)
		expect(canonical.outcome).toMatchObject({ status: "completed", requiresContinuation: true })
		expect(handler.getResponseId()).toBe("resp_fidelity")
	})

	it.each(["output_text", "refusal"] as const)("does not duplicate identical completed %s", async (kind) => {
		const item = message("Complete.", kind)
		mockStream(delta("Complete.", kind), done(item), done(item), completed([item]))
		const { chunks, failure, canonical } = await consume()
		expect(failure).toBeUndefined()
		expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text)).toEqual(["Complete."])
		expect(canonical.text).toBe("Complete.")
	})

	it.each(
		(["output_text", "refusal"] as const).flatMap((kind) =>
			["done", "completed"].map((source) => ({ kind, source })),
		),
	)("emits final-only $kind first supplied by $source once", async ({ kind, source }) => {
		const item = message("Final-only text.", kind)
		mockStream(...(source === "done" ? [done(item), done(item)] : []), completed([item]))
		const { chunks, failure, canonical } = await consume()
		expect(failure).toBeUndefined()
		expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text)).toEqual(["Final-only text."])
		expect(canonical.text).toBe("Final-only text.")
	})

	it.each(
		["done", "repeated_done", "completed", "completed_only"].flatMap((source) =>
			[
				{ label: "replacement", final: message("Changed") },
				{ label: "shorter text", final: message("Hell") },
				{ label: "changed part type", final: message("Hello", "refusal") },
				{ label: "removed part", final: { ...message(""), content: [] } },
			].map((fixture) => ({ source, ...fixture })),
		),
	)("rejects $label at $source instead of silently accepting incompatible content", async ({ source, final }) => {
		const partial = message("Hello")
		const receipts =
			source === "done"
				? [done(final)]
				: source === "repeated_done"
					? [done(partial), done(final)]
					: source === "completed"
						? [done(partial)]
						: []
		mockStream(delta("Hello"), ...receipts, completed([final]))
		const { chunks, failure, canonical } = await consume()
		expect(failure).toMatchObject({ message: expect.stringContaining("did not match its final content") })
		expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text)).toEqual(["Hello"])
		expect(canonical.outcome?.status).toBe("failed")
		expect(chunks.some((chunk) => chunk.type === "outcome")).toBe(false)
	})

	it("reconciles ordered text parts separately", async () => {
		const item = { ...message("One."), content: [part("One."), part(" Two.")] }
		mockStream(delta("One."), delta(" Two", "output_text", 1), done(item), completed([item]))
		const { failure, canonical } = await consume()
		expect(failure).toBeUndefined()
		expect(canonical.text).toBe("One. Two.")
	})

	it("rejects a suffix that would have to precede text already emitted from a later part", async () => {
		const item = { ...message("One."), content: [part("One."), part(" Two.")] }
		mockStream(delta("One"), delta(" Two.", "output_text", 1), done(item), completed([item]))
		const { chunks, failure, canonical } = await consume()
		expect(failure).toMatchObject({ message: expect.stringContaining("changed its emitted content order") })
		expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text)).toEqual(["One", " Two."])
		expect(canonical.outcome?.status).toBe("failed")
	})

	it("rejects a final output array that omits its streamed source message", async () => {
		mockStream(delta("Hello"), completed([]))
		const { chunks, failure, canonical } = await consume()
		expect(failure).toMatchObject({ message: expect.stringContaining("did not match its final output") })
		expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text)).toEqual(["Hello"])
		expect(canonical.outcome?.status).toBe("failed")
	})

	it("accepts a minimal terminal envelope after its full item receipt", async () => {
		mockStream(delta("Hello"), done(message("Hello world")), {
			type: "response.completed",
			response: { id: "resp_minimal", end_turn: false },
		})
		const { failure, canonical, handler } = await consume()
		expect(failure).toBeUndefined()
		expect(canonical.text).toBe("Hello world")
		expect(canonical.outcome).toMatchObject({ status: "completed", requiresContinuation: true })
		expect(handler.getResponseId()).toBe("resp_minimal")
	})

	it("retains streamed text when an interrupted terminal omits the unfinished message", async () => {
		mockStream(delta("Hello"), {
			type: "response.incomplete",
			response: {
				id: "resp_interrupted",
				status: "incomplete",
				incomplete_details: { reason: "interrupted" },
				output: [],
			},
		})
		const { failure, canonical } = await consume()
		expect(failure).toBeUndefined()
		expect(canonical.text).toBe("Hello")
		expect(canonical.outcome).toMatchObject({ status: "completed", requiresContinuation: true })
	})

	it.each([-1, 0.5, "0"])("rejects invalid content index %s before accepting text", async (content_index) => {
		mockStream({ ...delta("Hello"), content_index })
		const { chunks, failure } = await consume()
		expect(failure).toMatchObject({ message: expect.stringContaining("text part has an invalid index") })
		expect(chunks).toEqual([])
	})

	it("retains canonical item ordering, opaque reasoning and tool identity when text is completed late", async () => {
		const reasoning = {
			type: "reasoning",
			id: "rs_fidelity",
			encrypted_content: "opaque-fixture",
			summary: [{ type: "summary_text", text: "Retained summary." }],
		}
		const call = {
			type: "function_call",
			id: "fc_fidelity",
			call_id: "call_fidelity",
			name: "read_file",
			arguments: '{"path":"file.txt"}',
		}
		const item = message("Hello world")
		mockStream(
			delta("Hello", "output_text", 0, 2),
			done(reasoning, 0),
			done(call, 1),
			done(item, 2),
			completed([reasoning, call, item]),
		)
		const { chunks, failure, canonical, handler } = await consume()
		expect(failure).toBeUndefined()
		expect(canonical.items.filter((entry) => entry.type !== "usage")).toEqual([
			{
				type: "reasoning",
				text: "",
				id: "rs_fidelity",
				encryptedContent: "opaque-fixture",
				summary: reasoning.summary,
			},
			{ type: "tool_call", id: "call_fidelity", name: "read_file", arguments: { path: "file.txt" } },
			{ type: "text", text: "Hello", id: "msg_fidelity", phase: "final_answer", outputIndex: 2 },
			{ type: "text", text: " world", id: "msg_fidelity", phase: "final_answer", outputIndex: 2 },
		])
		expect(chunks.filter((chunk) => chunk.type === "tool_call_end")).toEqual([
			{ type: "tool_call_end", id: "call_fidelity" },
		])
		expect(chunks).toContainEqual({
			type: "reasoning",
			text: "",
			id: "rs_fidelity",
			encryptedContent: "opaque-fixture",
			summary: reasoning.summary,
			outputIndex: 0,
		})
		expect(handler.getReasoningItems()).toEqual([
			{ id: "rs_fidelity", encrypted_content: "opaque-fixture", summary: reasoning.summary },
		])
		expect(canonical.outcome).toMatchObject({ status: "completed", requiresContinuation: true })
	})
})
