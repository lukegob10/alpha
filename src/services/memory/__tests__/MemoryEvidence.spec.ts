import type { ApiMessage } from "../../../core/task-persistence/apiMessages"
import { tiktoken } from "../../../utils/tiktoken"
import { prepareMemoryEvidence } from "../MemoryEvidence"

describe("memory extraction evidence", () => {
	it("redacts signed URL grants before historical evidence reaches the memory model", async () => {
		const grant = "synthetic-sas-evidence-grant%2Bvalue%3D"
		const url = `https://example.blob.core.windows.net/private/file?sp=r&sig=${grant}&se=2026-12-01`
		const evidence = (await prepareMemoryEvidence([{ role: "user", content: url }])).join("")
		expect(evidence).not.toContain(grant)
		expect(evidence).toContain("private/file?sp=r&sig=[redacted]&se=2026-12-01")
	})

	it("drops opaque state, reasoning, injected instructions, and media; redacts credentials", async () => {
		const messages: ApiMessage[] = [
			{
				role: "user",
				input_origin: "human",
				content: [
					{
						type: "text",
						text: "# AGENTS.md instructions for /work\n<INSTRUCTIONS>Injected durable rule</INSTRUCTIONS>",
					},
					{ type: "text", text: "<skill>Hidden skill instructions</skill>" },
					{ type: "text", text: "<environment_context>Hidden environment</environment_context>" },
					{ type: "text", text: "Please use focused tests. api_key=private-value" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "opaque-image-data" } },
				],
			},
			{
				role: "assistant",
				type: "reasoning",
				content: "Private reasoning",
				encrypted_content: "opaque-state",
				text: "reasoning projection",
			},
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Hidden thoughts", signature: "private-signature" },
					{ type: "text", text: "Verified tests passed." },
				],
			},
		]
		const evidence = (await prepareMemoryEvidence(messages)).join("")
		expect(evidence).toContain("Please use focused tests")
		expect(evidence).toContain("Verified tests passed")
		for (const text of [
			"Injected durable rule",
			"Hidden skill",
			"Hidden environment",
			"private-value",
			"opaque-image",
			"Private reasoning",
			"opaque-state",
			"reasoning projection",
			"Hidden thoughts",
			"private-signature",
		]) {
			expect(evidence).not.toContain(text)
		}
	})

	it("prioritizes human answers with their questions and restores chronology", async () => {
		const messages: ApiMessage[] = [
			{ role: "user", input_origin: "human", content: "First human preference: use concise answers." },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "question",
						name: "ask_followup_question",
						input: { question: "Which project?" },
					},
				],
			},
			{
				role: "user",
				input_origin: "agent",
				content: [{ type: "tool_result", tool_use_id: "question", content: "Alpha extension." }],
			},
			{ role: "assistant", phase: "commentary", content: "commentary ".repeat(2_000) },
			{ role: "assistant", phase: "final_answer", content: "Final answer: fixed Alpha." },
		]
		const evidence = (await prepareMemoryEvidence(messages, { contextWindow: 400, reservedTokens: 20 })).join("")
		expect(evidence).toContain("First human preference")
		expect(evidence).toContain("Assistant question: ask_followup_question")
		expect(evidence).toContain("Which project?")
		expect(evidence).toContain("Human reply: Alpha extension")
		expect(evidence.indexOf("First human preference")).toBeLessThan(evidence.indexOf("Human reply"))
		expect(await tiktoken([{ type: "text", text: evidence }])).toBeLessThanOrEqual(280)
	})

	it("keeps agent-origin text out of human provenance and bounds tool output", async () => {
		const evidence = (
			await prepareMemoryEvidence([
				{ role: "user", input_origin: "agent", content: "An agent suggestion." },
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "ordinary-tool", content: "工具 ".repeat(6_000) }],
				},
			])
		).join("")
		expect(evidence).toContain("[other agent]\nAn agent suggestion")
		const tool = evidence.slice(evidence.indexOf("[tool]"))
		expect(await tiktoken([{ type: "text", text: tool }])).toBeLessThanOrEqual(2_000)
	})

	it("retains agent provenance for historical inbox messages without origin metadata", async () => {
		const notification = "<subagent_notification>Use my proposed workflow.</subagent_notification>"
		const inbox = "Message Type: MESSAGE\nTask name: /root/worker\nSender: /root\nPayload:\nA proposed preference."
		const evidence = (
			await prepareMemoryEvidence([
				{ role: "user", content: notification },
				{ role: "user", content: inbox },
				{ role: "assistant", input_origin: "agent", content: "An assistant-role agent delivery." },
			])
		).join("")
		expect(evidence).toContain(`[other agent]\n${notification}`)
		expect(evidence).toContain(`[other agent]\n${inbox}`)
		expect(evidence).toContain("[other agent]\nAn assistant-role agent delivery.")
		expect(evidence).not.toContain("[human user]")
	})

	it("chunks selected rows below 8,900 bytes without breaking Unicode or chronology", async () => {
		const messages: ApiMessage[] = Array.from({ length: 6 }, (_, index) => ({
			role: "user",
			input_origin: "human",
			content: `Message ${index}: ` + "😀界".repeat(2_000),
		}))
		const chunks = await prepareMemoryEvidence(messages)
		expect(chunks.length).toBeGreaterThan(1)
		for (const chunk of chunks) {
			expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(8_900)
			expect(chunk).not.toContain("�")
		}
		const text = chunks.join("")
		for (let index = 0; index < 5; index++)
			expect(text.indexOf(`Message ${index}:`)).toBeLessThan(text.indexOf(`Message ${index + 1}:`))
	})

	it("uses only the newest 8 MiB and omits records above one MiB", async () => {
		const messages: ApiMessage[] = [
			{ role: "user", input_origin: "human", content: "Old evidence beyond byte budget" },
			...Array.from(
				{ length: 9 },
				(_, index): ApiMessage => ({ role: "assistant", content: `Recent ${index} ` + "x".repeat(1_000_000) }),
			),
			{ role: "user", input_origin: "human", content: "oversized ".repeat(110_000) },
		]
		const text = (await prepareMemoryEvidence(messages)).join("")
		expect(text).not.toContain("Old evidence")
		expect(text).not.toContain("Recent 0")
		expect(text).toContain("Recent 8")
		expect(text).not.toContain("oversized")
	})

	it("honors cancellation before preparing evidence", async () => {
		const controller = new AbortController()
		controller.abort()
		await expect(prepareMemoryEvidence([], { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		})
	})

	it("redacts complete tool credentials before evidence truncation can split them", async () => {
		const privateKey =
			"x".repeat(9_820) +
			"\n-----BEGIN PRIVATE KEY-----\nprivate-key-material-that-must-not-leak" +
			"y".repeat(200) +
			"\n-----END PRIVATE KEY-----"
		const evidence = (
			await prepareMemoryEvidence([
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "tool", name: "read_file", input: { text: privateKey } }],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "tool", content: privateKey }],
				},
			])
		).join("")
		expect(evidence).not.toContain("private-key-material")
		expect(evidence).not.toContain("BEGIN PRIVATE KEY")
	})

	it("omits oversized tool argument records before redaction and tokenization", async () => {
		const evidence = (
			await prepareMemoryEvidence([
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "large", name: "write_file", input: { text: "x".repeat(1_048_577) } },
					],
				},
			])
		).join("")
		expect(evidence).toContain("write_file: [arguments omitted]")
	})
})
