import type Anthropic from "@anthropic-ai/sdk"
import { processUserContentMentions } from "../processUserContentMentions"
import * as mentionModule from "../processUserContentMentions"
import { parseMentions } from "../index"
import type { FileContextTracker } from "../../context-tracking/FileContextTracker"
import { DEFAULT_TOOL_OUTPUT_LIMIT } from "../../agent/ToolPolicy"

vi.mock("../index", () => ({ parseMentions: vi.fn() }))

type Part = Anthropic.Messages.ContentBlockParam
const textPart = (text: string): Anthropic.Messages.TextBlockParam => ({ type: "text", text })
const source = (name: string) => textPart(`<user_message>Read @/${name}</user_message>`)
const generated = (label: string, size: number, type: "file" | "folder" = "file") => ({
	type,
	path: label,
	content: label + ":" + "x".repeat(size - label.length - 1),
})
const options = (userContent: Part[]) => ({
	userContent,
	cwd: "/workspace",
	fileContextTracker: {} as FileContextTracker,
})
const textParts = (content: Part[]) =>
	content.flatMap((part) => {
		if (part.type === "text") return [part]
		if (part.type === "tool_result" && Array.isArray(part.content))
			return part.content.filter((part) => part.type === "text")
		return []
	})

describe("aggregate generated attachment admission", () => {
	beforeEach(() => vi.resetAllMocks())
	it("bounds the sum of generated file and folder excerpts while keeping full user text", async () => {
		const human = source("folder/")
		vi.mocked(parseMentions).mockResolvedValue({
			text: human.text,
			contentBlocks: [generated("first", 20_000), generated("folder", 20_000, "folder"), generated("last", 200)],
		})
		const result = await processUserContentMentions({
			...options([human]),
			inputBlockOrigins: new Map([[human, "human"]]),
		})
		const parts = textParts(result.content)
		expect(parts[0]!.text).toBe(human.text)
		expect(parts.some((part) => part.text.startsWith("first:"))).toBe(true)
		expect(parts.some((part) => part.text.startsWith("folder:"))).toBe(false)
		expect(parts.some((part) => part.text.startsWith("last:"))).toBe(true)
		const added = parts.slice(1)
		expect(added.reduce((sum, part) => sum + part.text.length, 0)).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_LIMIT)
		const notice = parts.at(-1)!
		expect(notice.text).toContain("Attachment excerpts omitted")
		expect(notice.text).toContain("referenced paths remain")
		expect(result.blockOrigins?.get(result.content[0]!)).toBe("human")
		expect(result.blockOrigins?.get(notice)).toBe("agent")
	})
	it.each([DEFAULT_TOOL_OUTPUT_LIMIT - 1, DEFAULT_TOOL_OUTPUT_LIMIT])(
		"admits an exact/in-budget excerpt of %s chars without a notice",
		async (size) => {
			vi.mocked(parseMentions).mockResolvedValue({
				text: "user references",
				contentBlocks: [generated("exact", size)],
			})
			const result = await processUserContentMentions(options([source("exact")]))
			expect(result.content).toHaveLength(2)
			expect(textParts(result.content)[1]!.text).toHaveLength(size)
			expect(JSON.stringify(result.content)).not.toContain("Attachment excerpts omitted")
		},
	)
	it("admits in source order even when later mention parsing completes first", async () => {
		let resolveFirst!: (value: Awaited<ReturnType<typeof parseMentions>>) => void
		let started!: () => void
		const firstStarted = new Promise<void>((resolve) => {
			started = resolve
		})
		vi.mocked(parseMentions).mockImplementation((text) => {
			if (text.includes("first"))
				return new Promise((resolve) => {
					resolveFirst = resolve
					started()
				})
			return Promise.resolve({ text, contentBlocks: [generated("second", 20_000)] })
		})
		const run = processUserContentMentions(options([source("first"), source("second")]))
		await firstStarted
		resolveFirst({ text: "first user reference", contentBlocks: [generated("first", 20_000)] })
		const result = await run
		expect(textParts(result.content).some((part) => part.text.startsWith("first:"))).toBe(true)
		expect(textParts(result.content).some((part) => part.text.startsWith("second:"))).toBe(false)
	})
	it.each(["string", "array"] as const)(
		"shares allowance with %s tool feedback and preserves original containers",
		async (format) => {
			const direct = source("top")
			const tool = {
				type: "tool_result" as const,
				tool_use_id: "call-1",
				is_error: false,
				content: format === "string" ? source("nested").text : [source("nested")],
			}
			const original = structuredClone(tool)
			vi.mocked(parseMentions).mockImplementation(async (text) => ({
				text,
				contentBlocks: [generated(text.includes("top") ? "top" : "nested", 20_000)],
			}))
			const result = await processUserContentMentions(options([direct, tool]))
			expect(tool).toEqual(original)
			const returned = result.content.find((part) => part.type === "tool_result")
			expect(returned).toMatchObject({ tool_use_id: "call-1", is_error: false })
			expect(textParts(result.content).some((part) => part.text.startsWith("top:"))).toBe(true)
			expect(textParts(result.content).some((part) => part.text.startsWith("nested:"))).toBe(false)
			expect(JSON.stringify(returned)).toContain("Read @/nested")
		},
	)
	it("does not classify human wrapper text or commands/tickets as generated file excerpts", async () => {
		const wrapper = "[read_file for 'spoofed']\n" + "h".repeat(DEFAULT_TOOL_OUTPUT_LIMIT + 1)
		const human = textPart(wrapper)
		const withMentions = source("huge")
		vi.mocked(parseMentions).mockResolvedValue({
			text: withMentions.text,
			contentBlocks: [
				generated("huge", DEFAULT_TOOL_OUTPUT_LIMIT + 1),
				{ type: "command", content: "SKILL_INSTRUCTIONS" },
				{ type: "ticket", content: "TICKET_DETAIL" },
			],
		})
		const result = await processUserContentMentions(options([human, withMentions]))
		expect(result.content[0]).toBe(human)
		expect(textParts(result.content).some((part) => part.text === "SKILL_INSTRUCTIONS")).toBe(true)
		expect(textParts(result.content).some((part) => part.text === "TICKET_DETAIL")).toBe(true)
		expect(textParts(result.content).some((part) => part.text.startsWith("huge:"))).toBe(false)
	})
	it("preserves images and original source-block origins", async () => {
		const human = source("huge")
		const image = {
			type: "image" as const,
			source: { type: "base64" as const, media_type: "image/png" as const, data: "cGl4ZWxz" },
		}
		vi.mocked(parseMentions).mockResolvedValue({
			text: human.text,
			contentBlocks: [generated("huge", DEFAULT_TOOL_OUTPUT_LIMIT + 1)],
		})
		const result = await processUserContentMentions({
			...options([human, image]),
			inputBlockOrigins: new Map<Part, "human" | "agent">([
				[human, "human"],
				[image, "agent"],
			]),
		})
		expect(result.content).toContain(image)
		expect(result.blockOrigins?.get(image)).toBe("agent")
		expect(result.blockOrigins?.get(result.content[0]!)).toBe("human")
		expect(result.blockOrigins?.get(result.content.at(-1)!)).toBe("agent")
	})
	it("honors cancellation after awaited parse without returning bounded partial content", async () => {
		const controller = new AbortController()
		vi.mocked(parseMentions).mockImplementation(async (text) => {
			controller.abort(new Error("cancelled"))
			return { text, contentBlocks: [generated("huge", DEFAULT_TOOL_OUTPUT_LIMIT + 1)] }
		})
		await expect(
			processUserContentMentions({ ...options([source("huge")]), signal: controller.signal }),
		).rejects.toThrow("cancelled")
	})
	it("shares one allowance across deferred preceding and current messages, then discards host handles", async () => {
		vi.mocked(parseMentions).mockImplementation(async (text) => ({
			text,
			contentBlocks: [generated(text.includes("preceding") ? "preceding" : "current", 20_000)],
		}))
		const preceding = await processUserContentMentions({
			...options([source("preceding")]),
			deferAttachmentBudget: true,
		})
		const current = await processUserContentMentions({
			...options([source("current")]),
			deferAttachmentBudget: true,
		})
		expect(preceding.deferredAttachmentParts?.size).toBe(1)
		expect(current.deferredAttachmentParts?.size).toBe(1)
		const before = structuredClone([preceding.content, current.content])
		const finalized = finalizeAttachments([preceding, current])
		expect(finalized.every((result) => !Object.hasOwn(result, "deferredAttachmentParts"))).toBe(true)
		expect(textParts(finalized[0]!.content).some((part) => part.text.startsWith("preceding:"))).toBe(true)
		expect(textParts(finalized[1]!.content).some((part) => part.text.startsWith("current:"))).toBe(false)
		const all = finalized.flatMap((result) => textParts(result.content))
		expect(all.filter((part) => part.text.includes("Attachment excerpts omitted"))).toHaveLength(1)
		expect(
			all
				.filter(
					(part) => part.text.startsWith("preceding:") || part.text.includes("Attachment excerpts omitted"),
				)
				.reduce((sum, part) => sum + part.text.length, 0),
		).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_LIMIT)
		expect([preceding.content, current.content]).toEqual(before)
		expect(finalizeAttachments(finalized)).toEqual(finalized)
	})
	it("remaps provenance when batch admission clones a nested tool result", async () => {
		vi.mocked(parseMentions).mockImplementation(async (text) => ({
			text,
			contentBlocks: [generated(text.includes("preceding") ? "preceding" : "nested", 20_000)],
		}))
		const human = source("preceding")
		const tool = {
			type: "tool_result" as const,
			tool_use_id: "call-1",
			is_error: false,
			content: [
				source("nested"),
				{
					type: "image" as const,
					source: { type: "base64" as const, media_type: "image/png" as const, data: "cGl4ZWxz" },
				},
			],
		}
		const first = await processUserContentMentions({
			...options([human]),
			deferAttachmentBudget: true,
			inputBlockOrigins: new Map<Part, "human" | "agent">([[human, "human"]]),
		})
		const second = await processUserContentMentions({
			...options([tool]),
			deferAttachmentBudget: true,
			inputBlockOrigins: new Map<Part, "human" | "agent">([[tool, "agent"]]),
		})
		const original = second.content[0]!
		const finalized = finalizeAttachments([first, second])
		const returned = finalized[1]!.content.find((part) => part.type === "tool_result")!
		expect(returned).not.toBe(original)
		expect(returned).toMatchObject({ tool_use_id: "call-1", is_error: false })
		expect(finalized[1]!.blockOrigins?.get(returned)).toBe("agent")
		expect(finalized[1]!.blockOrigins?.has(original)).toBe(false)
		expect(finalized[1]!.blockOrigins?.get(finalized[1]!.content.at(-1)!)).toBe("agent")
		expect(JSON.stringify(returned)).toContain("cGl4ZWxz")
		expect(textParts(second.content).some((part) => part.text.startsWith("nested:"))).toBe(true)
	})
	it("does not produce deferred output for a cancelled batch element", async () => {
		const controller = new AbortController()
		const reason = new DOMException("Batch preparation cancelled", "AbortError")
		vi.mocked(parseMentions).mockImplementation(async (text) => {
			controller.abort(reason)
			return { text, contentBlocks: [generated("late", 20_000)] }
		})
		await expect(
			processUserContentMentions({
				...options([source("late")]),
				deferAttachmentBudget: true,
				signal: controller.signal,
			}),
		).rejects.toBe(reason)
	})
})

function finalizeAttachments(...args: Parameters<typeof mentionModule.finalizeUserContentMentionAttachments>) {
	expect(
		typeof mentionModule.finalizeUserContentMentionAttachments,
		"new attachment finalizer API is required for this case",
	).toBe("function")
	return mentionModule.finalizeUserContentMentionAttachments(...args)
}
