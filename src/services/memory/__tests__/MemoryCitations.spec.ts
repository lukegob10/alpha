import { describe, expect, it } from "vitest"
import { normalizeAssistantMessageMetadata } from "@alpha-code/types"
import { createAgentResponse } from "../../../core/agent/AgentResponse"
import { buildCanonicalAssistantHistoryItems } from "../../../core/task-persistence/canonicalAssistantHistory"
import { splitMemoryCitations, stripMemoryCitations } from "../../../shared/memory-citations"
import {
	assistantMemoryCitationReferences,
	parseMemoryCitationReferences,
	parseMemoryCitation,
	withAssistantMemoryCitations,
} from "../MemoryCitations"

const body = (ids = "source-1") => `<rollout_ids>\n${ids}\n</rollout_ids>`
const citation = (ids = "source-1") => `<alpha-mem-citation>\n${body(ids)}\n</alpha-mem-citation>`

describe("Alpha memory citations", () => {
	it("round-trips citation locations and notes through canonical text merging and persistence", () => {
		const block = `<citation_entries>\nrollout_summaries/source-1.md:2-8|note=[prior task evidence]\n</citation_entries>\n${body()}`
		const raw = `Answer.\n<alpha-mem-citation>\n${block}\n</alpha-mem-citation>`
		const response = createAgentResponse([
			{ type: "text", id: "message-1", phase: "final_answer", text: raw.slice(0, 12) },
			{ type: "text", id: "message-1", phase: "final_answer", text: raw.slice(12) },
		])
		const enriched = withAssistantMemoryCitations(response)
		const expected = {
			entries: [{ path: "rollout_summaries/source-1.md", lineStart: 2, lineEnd: 8, note: "prior task evidence" }],
			rolloutIds: ["source-1"],
		}
		expect(enriched.text).toBe(raw)
		expect(response.items).not.toEqual(enriched.items)
		expect(response.items[1]).not.toHaveProperty("memoryCitation")
		const history = buildCanonicalAssistantHistoryItems(enriched)
		expect(history).toHaveLength(1)
		expect(history[0]).toMatchObject({ text: raw, memoryCitation: expected })
		expect(normalizeAssistantMessageMetadata(JSON.parse(JSON.stringify(history[0])))).toMatchObject({
			memoryCitation: expected,
		})
		expect(assistantMemoryCitationReferences(enriched)).toEqual(["rollout_summaries/source-1.md", "source-1"])
	})

	it("retains index attribution without marking an index as rollout usage", () => {
		const block = `<citation_entries>\nMEMORY.md:1-2|note=[index]\nmemory_summary.md:3-4|note=[summary]\n</citation_entries>`
		expect(parseMemoryCitation(block)).toEqual({
			entries: [
				{ path: "MEMORY.md", lineStart: 1, lineEnd: 2, note: "index" },
				{ path: "memory_summary.md", lineStart: 3, lineEnd: 4, note: "summary" },
			],
			rolloutIds: [],
		})
		expect(parseMemoryCitationReferences(block)).toEqual([])
	})

	it.each([
		"../outside.md",
		"/private.md",
		"rollout_summaries/../../private.md",
		"file:///private.md",
		"command:run",
	])("rejects unsafe structured citation locations: %s", (path) => {
		expect(
			parseMemoryCitation(`<citation_entries>\n${path}:1-2|note=[unsafe]\n</citation_entries>`),
		).toBeUndefined()
		expect(
			normalizeAssistantMessageMetadata({
				id: "safe-identity",
				memoryCitation: { entries: [{ path, lineStart: 1, lineEnd: 2, note: "unsafe" }], rolloutIds: [] },
			}),
		).toEqual({ id: "safe-identity" })
	})

	it("preserves structured citation provenance in normalized canonical metadata", () => {
		const memoryCitation = {
			entries: [{ path: "rollout_summaries/source.md", lineStart: 2, lineEnd: 8, note: "prior task evidence" }],
			rolloutIds: ["source-1"],
		}
		expect(normalizeAssistantMessageMetadata({ id: "message-1", memoryCitation })).toEqual({
			id: "message-1",
			memoryCitation,
		})
	})

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
