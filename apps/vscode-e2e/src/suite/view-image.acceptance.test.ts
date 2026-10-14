import * as assert from "assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import * as vscode from "vscode"

import { AlphaCodeEventName, type AlphaCodeSettings } from "@alpha-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

const REAL_IMAGE_CALL_ID = "view-image-real-png"
const SPOOF_IMAGE_CALL_ID = "view-image-spoof-png"
const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=",
	"base64",
)

type RequestMetadata = { taskId?: string; tools?: unknown[] }
type ProviderMessage = { role?: unknown; content?: unknown }
type ProviderBlock = Record<string, unknown>

class ViewImageScriptedAI {
	readonly id = "view-image-exact-host-scripted"
	readonly requests: unknown[][] = []
	readonly toolSchemas: unknown[][] = []
	removeFromCache?: () => void

	async *createMessage(_system: string, messages: unknown[], metadata?: RequestMetadata) {
		assert.ok(metadata?.taskId, "Every image acceptance request must belong to the real extension task")
		this.requests.push(structuredClone(messages))
		this.toolSchemas.push(structuredClone(metadata.tools ?? []))

		switch (this.requests.length) {
			case 1:
				yield {
					type: "tool_call" as const,
					id: REAL_IMAGE_CALL_ID,
					name: "view_image",
					arguments: JSON.stringify({ path: this.realImagePath }),
				}
				return
			case 2:
				yield {
					type: "tool_call" as const,
					id: SPOOF_IMAGE_CALL_ID,
					name: "view_image",
					arguments: JSON.stringify({ path: this.spoofImagePath }),
				}
				return
			case 3:
				yield { type: "text" as const, text: "Viewed the real PNG and rejected the spoofed image." }
				return
			default:
				assert.fail(`Unexpected image acceptance continuation ${this.requests.length}`)
		}
	}

	constructor(
		readonly realImagePath: string,
		readonly spoofImagePath: string,
	) {}

	getModel() {
		return {
			id: this.id,
			info: { contextWindow: 128_000, maxTokens: 8_192, supportsImages: true, supportsPromptCache: false },
		}
	}

	async countTokens(content: unknown[]): Promise<number> {
		return Math.max(1, Math.ceil(JSON.stringify(content).length / 4))
	}

	async completePrompt(): Promise<string> {
		return ""
	}
}

type AcceptanceTask = {
	taskAsk?: { ask?: string; partial?: boolean }
	clineMessages: Array<{ say?: string; text?: string; partial?: boolean }>
	approveAsk(): void
	waitForTermination(): Promise<void>
	flushApiConversationHistoryPersistence(): Promise<void>
}

type AcceptanceProvider = {
	getLiveTask(taskId: string): AcceptanceTask | undefined
}

function isRecord(value: unknown): value is ProviderBlock {
	return !!value && typeof value === "object" && !Array.isArray(value)
}

function asMessages(value: unknown): ProviderMessage[] {
	return Array.isArray(value) ? (value.filter(isRecord) as ProviderMessage[]) : []
}

function asBlocks(value: unknown): ProviderBlock[] {
	return Array.isArray(value) ? value.filter(isRecord) : []
}

function getMessageBlocks(messages: unknown[], type: string): Array<{ role: unknown; block: ProviderBlock }> {
	return asMessages(messages).flatMap((message) =>
		asBlocks(message.content)
			.filter((block) => block.type === type)
			.map((block) => ({ role: message.role, block })),
	)
}

function getImageBlocks(messages: unknown[]): ProviderBlock[] {
	return asMessages(messages).flatMap((message) =>
		asBlocks(message.content).filter((block) => block.type === "image"),
	)
}

function getToolSchema(tools: unknown[], name: string): ProviderBlock | undefined {
	return tools.find((tool): tool is ProviderBlock => {
		if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)) return false
		return tool.function.name === name
	})
}

suite("Alpha view_image native tool acceptance", function () {
	setDefaultSuiteTimeout(this)

	test("advertises view_image and delivers one real image result while rejecting a spoofed PNG", async () => {
		assert.equal(vscode.version, "1.125.0", "The image tool acceptance must run on the exact supported host")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")

		const workspace = vscode.workspace.workspaceFolders?.[0]
		assert.ok(workspace, "The exact-host acceptance test has no workspace folder")
		const fileSuffix = randomUUID()
		const realImagePath = `view-image-${fileSuffix}.png`
		const spoofImagePath = `view-image-spoof-${fileSuffix}.png`
		const realImageFsPath = path.join(workspace.uri.fsPath, realImagePath)
		const spoofImageFsPath = path.join(workspace.uri.fsPath, spoofImagePath)
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider?: AcceptanceProvider }).sidebarProvider
		assert.ok(provider, "The extension host did not expose its task provider")
		const originalConfiguration = api.getConfiguration()
		const model = new ViewImageScriptedAI(realImagePath, spoofImagePath)
		let completed = false
		let taskId: string | undefined
		const onCompleted = (completedTaskId: string) => {
			if (completedTaskId === taskId) completed = true
		}
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)

		try {
			await fs.writeFile(realImageFsPath, PNG_BYTES, { flag: "wx" })
			await fs.writeFile(spoofImageFsPath, "this file is not a PNG", { flag: "wx" })

			const configuration: AlphaCodeSettings = {
				...originalConfiguration,
				apiProvider: "fake-ai",
				fakeAi: model,
				mode: "code",
				approvalMode: "auto",
				autoApprovalEnabled: true,
				alwaysAllowReadOnly: true,
				enableCheckpoints: false,
				requestDelaySeconds: 0,
				writeDelayMs: 0,
			}
			taskId = await api.startNewTask({
				configuration,
				text: "Inspect the PNG in this workspace, then confirm that the fake PNG is rejected.",
			})

			await waitFor(
				() => {
					const task = provider.getLiveTask(taskId!)
					if (task?.taskAsk?.ask === "completion_result") task.approveAsk()
					return completed
				},
				{ timeout: 45_000, description: "the real and spoofed image tool calls to complete" },
			)
			const task = provider.getLiveTask(taskId)
			assert.ok(task, "The image acceptance task disappeared before it settled")
			await task.waitForTermination()
			await task.flushApiConversationHistoryPersistence()

			assert.equal(model.requests.length, 3, "Each image call and final answer must use one provider request")
			const schema = getToolSchema(model.toolSchemas[0] ?? [], "view_image")
			assert.ok(schema, "The image-capable provider did not receive the advertised view_image schema")
			assert.ok(
				getToolSchema(model.toolSchemas[1] ?? [], "view_image"),
				"The image-capable provider must still advertise view_image for the spoofed-file call",
			)
			assert.deepStrictEqual(
				schema.function && isRecord(schema.function) ? schema.function.parameters : undefined,
				{
					type: "object",
					properties: {
						path: {
							type: "string",
							description: "Local filesystem path to a supported image file.",
						},
					},
					required: ["path"],
					additionalProperties: false,
				},
			)

			const realResultRequest = model.requests[1]!
			const realCalls = getMessageBlocks(realResultRequest, "tool_use").filter(
				({ block }) => block.id === REAL_IMAGE_CALL_ID,
			)
			const realResults = getMessageBlocks(realResultRequest, "tool_result").filter(
				({ block }) => block.tool_use_id === REAL_IMAGE_CALL_ID,
			)
			assert.equal(realCalls.length, 1, "The valid view_image call must appear exactly once in provider history")
			assert.equal(realResults.length, 1, "The valid view_image call must have exactly one paired result")
			assert.equal(realCalls[0]?.role, "assistant")
			assert.equal(realResults[0]?.role, "user")
			assert.strictEqual(realResults[0]?.block.is_error, false, "The real image result must succeed")
			const realImages = getImageBlocks(realResultRequest)
			assert.equal(realImages.length, 1, "The next provider request must contain one image payload")
			assert.deepStrictEqual(realImages[0], {
				type: "image",
				source: { type: "base64", media_type: "image/png", data: PNG_BYTES.toString("base64") },
			})

			const spoofResultRequest = model.requests[2]!
			const spoofCalls = getMessageBlocks(spoofResultRequest, "tool_use").filter(
				({ block }) => block.id === SPOOF_IMAGE_CALL_ID,
			)
			const spoofResults = getMessageBlocks(spoofResultRequest, "tool_result").filter(
				({ block }) => block.tool_use_id === SPOOF_IMAGE_CALL_ID,
			)
			assert.equal(spoofCalls.length, 1, "The spoofed image call must be retained in provider history")
			assert.equal(spoofResults.length, 1, "The spoofed image call must have exactly one paired result")
			assert.equal(spoofCalls[0]?.role, "assistant")
			assert.equal(spoofResults[0]?.role, "user")
			const spoofResult = spoofResults[0]!.block
			assert.strictEqual(spoofResult.is_error, true, "The spoofed image result must be a terminal tool error")
			assert.match(JSON.stringify(spoofResult), /does not match the supported image format/i)
			assert.deepStrictEqual(
				getImageBlocks(spoofResultRequest),
				realImages,
				"The spoofed PNG result must not add any image payload to provider history",
			)
			assert.ok(
				task.clineMessages.some(
					({ say, text, partial }) =>
						(say === "text" || say === "completion_result") &&
						partial !== true &&
						text === "Viewed the real PNG and rejected the spoofed image.",
				),
				"The task must present its final answer after both image outcomes",
			)
		} finally {
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
			await api.clearCurrentTask().catch(() => undefined)
			await api.setConfiguration(originalConfiguration)
			model.removeFromCache?.()
			await fs.rm(realImageFsPath, { force: true })
			await fs.rm(spoofImageFsPath, { force: true })
		}
	})
})
