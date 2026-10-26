import { describe, expect, it } from "vitest"
import { createAgentResponse } from "../../../core/agent/AgentResponse"
import { splitMemoryCitations, stripMemoryCitations } from "../../../shared/memory-citations"
import { assistantMemoryCitationReferences, parseMemoryCitationReferences } from "../MemoryCitations"

const body = (ids = "source-1") => `<rollout_ids>\n${ids}\n</rollout_ids>`
const citation = (ids = "source-1") => `<alpha-mem-citation>\n${body(ids)}\n</alpha-mem-citation>`

describe("Alpha memory citations", () => {
	it("parses exact source IDs and relative rollout locations once", () => {
		expect(
			parseMemoryCitationReferences(
				`<citation_entries>\nrollout_summaries/source-1_project.md:2-8|note=[prior task evidence]\n</citation_entries>\n${body("source-1\nsource-1\n019c6e27-e55b-73d1-87d8-4e01f1f75043")}`,
			),
		).toEqual(["rollout_summaries/source-1_project.md", "source-1", "019c6e27-e55b-73d1-87d8-4e01f1f75043"])
	})

	it.each([
		"../outside",
		"/absolute/path",
		"file:///private",
		"command:run",
		"source%2fother",
		"source\\other",
		"<script>source</script>",
		"source-1\n</rollout_ids>\n<rollout_ids>\nsource-2",
	])("rejects a malformed or adversarial ID block: %s", (id) => {
		expect(parseMemoryCitationReferences(body(id))).toEqual([])
	})

	it.each([
		"rollout_summaries/../../private.md:1-2|note=[unsafe]",
		"memory_summary.md:1-2|note=[index]",
		"rollout_summaries/source.md:8-2|note=[backward]",
		"rollout_summaries/source.md:0-2|note=[zero]",
		"rollout_summaries/source.md:1-2|note=[<a href=command:run>]",
	])("rejects unsafe or invalid entries: %s", (entry) => {
		expect(parseMemoryCitationReferences(`<citation_entries>\n${entry}\n</citation_entries>`)).toEqual([])
	})

	it("rejects partial, nested, oversized, and excessive reference blocks", () => {
		expect(parseMemoryCitationReferences("<rollout_ids>\nsource-1")).toEqual([])
		expect(parseMemoryCitationReferences(`<alpha-mem-citation>\n${body()}\n</alpha-mem-citation>`)).toEqual([])
		expect(parseMemoryCitationReferences(body("x".repeat(16_384)))).toEqual([])
		expect(
			parseMemoryCitationReferences(body(Array.from({ length: 129 }, (_, i) => `source-${i}`).join("\n"))),
		).toEqual([])
	})

	it("joins finalized text fragments but excludes reasoning, tool input, and commentary", () => {
		const text = `Answer.\n${citation("source-1\nsource-1")}`
		const split = text.indexOf("<rollout_ids>") + 5
		expect(
			assistantMemoryCitationReferences(
				createAgentResponse([
					{ type: "reasoning", text: citation("reasoning-source") },
					{ type: "text", text: citation("commentary-source"), phase: "commentary" },
					{ type: "text", text: citation("partial-source"), phase: "partial_answer" },
					{
						type: "tool_call",
						id: "call-1",
						name: "read_file",
						arguments: { text: citation("tool-source") },
					},
					{ type: "text", text: text.slice(0, split), id: "message-1", phase: "final_answer" },
					{ type: "text", text: text.slice(split), id: "message-1", phase: "final_answer" },
				]),
			),
		).toEqual(["source-1"])
	})

	it("does not stitch tags across distinct messages, reasoning, or tool calls", () => {
		const split = citation().indexOf("source-1")
		for (const middle of [
			[{ type: "tool_call" as const, id: "call-1", name: "read_file", arguments: {} }],
			[{ type: "reasoning" as const, text: "Private thoughts" }],
		]) {
			expect(
				assistantMemoryCitationReferences(
					createAgentResponse([
						{ type: "text", text: citation().slice(0, split) },
						...middle,
						{ type: "text", text: citation().slice(split) },
					]),
				),
			).toEqual([])
		}
		expect(
			assistantMemoryCitationReferences(
				createAgentResponse([
					{ type: "text", text: citation().slice(0, split), id: "first" },
					{ type: "text", text: citation().slice(split), id: "second" },
				]),
			),
		).toEqual([])
	})

	it("hides metadata during streaming and final display while preserving ordinary text and code examples", () => {
		expect(stripMemoryCitations(`Answer.\n\n${citation()}`)).toBe("Answer.")
		expect(stripMemoryCitations("Answer.\n<alpha-mem-cit", true)).toBe("Answer.")
		expect(splitMemoryCitations("Answer.\n<alpha-mem-citation>\n<rollout_ids>\nsource-1")).toEqual({
			text: "Answer.",
			blocks: [],
		})
		const example = `Example:\n\`\`\`xml\n${citation()}\n\`\`\`\n`
		expect(stripMemoryCitations(example)).toBe(example)
		expect(assistantMemoryCitationReferences(createAgentResponse([{ type: "text", text: example }]))).toEqual([])
		expect(stripMemoryCitations("An ordinary answer.\n")).toBe("An ordinary answer.\n")
	})

	it("keeps oversized metadata invisible without accepting it for usage", () => {
		const text = `Answer.\n${citation("x".repeat(16_385))}`
		expect(stripMemoryCitations(text)).toBe("Answer.")
		expect(assistantMemoryCitationReferences(createAgentResponse([{ type: "text", text }]))).toEqual([])
	})
})
