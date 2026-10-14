import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { type AlphaCodeSettings } from "@alpha-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

type ScriptChunk =
	| { type: "text"; text: string }
	| { type: "usage"; inputTokens: number; outputTokens: number; totalCost: number }

class InstructionDiscoveryScriptedAI {
	readonly requests: Array<{ systemPrompt: string; messages: unknown[] }> = []
	readonly id = "instruction-discovery-acceptance"

	async *createMessage(systemPrompt: string, messages: unknown[], metadata?: { taskId?: string }) {
		assert.ok(metadata?.taskId, "The instruction discovery request must belong to a real task")
		this.requests.push({ systemPrompt, messages: structuredClone(messages) })
		yield { type: "text", text: "Instruction discovery completed visibly." } satisfies ScriptChunk
		yield { type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0 } satisfies ScriptChunk
	}

	getModel() {
		return {
			id: this.id,
			info: { contextWindow: 16_000, maxTokens: 1_000, supportsImages: false, supportsPromptCache: false },
		}
	}

	async countTokens(content: unknown[]): Promise<number> {
		return content.reduce<number>((tokens, block) => tokens + Math.ceil(JSON.stringify(block).length / 4), 0)
	}

	async completePrompt(): Promise<string> {
		return ""
	}
}

suite("Alpha project instruction discovery acceptance", function () {
	setDefaultSuiteTimeout(this)

	test("loads ancestor AGENTS.override before its standard file and includes cwd guidance on VS Code 1.125.0", async () => {
		assert.equal(vscode.version, "1.125.0")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		assert.ok(workspace, "The runner must supply its owned workspace")

		const workspacePath = path.resolve(workspace)
		const ownedRoot = path.dirname(workspacePath)
		const projectInstructionLimit = 32 * 1024
		const ancestorOverridePrefix = "R".repeat(projectInstructionLimit - 6)
		assert.equal(path.basename(workspacePath), "workspace", "This test requires the disposable E2E workspace")
		const ownership = JSON.parse(await fs.readFile(path.join(ownedRoot, ".alpha-e2e-owned.json"), "utf8")) as {
			schemaVersion?: number
			purpose?: string
			kind?: string
		}
		assert.deepEqual(ownership, { schemaVersion: 1, purpose: "alpha-vscode-e2e", kind: "temporary" })

		const gitMarker = path.join(ownedRoot, ".git")
		const ancestorStandard = path.join(ownedRoot, "AGENTS.md")
		const ancestorOverride = path.join(ownedRoot, "AGENTS.override.md")
		const ancestorLocal = path.join(ownedRoot, "AGENTS.local.md")
		const workspaceInstructions = path.join(workspacePath, "AGENTS.md")
		const instructionFiles = [ancestorStandard, ancestorOverride, ancestorLocal, workspaceInstructions]
		const originalFiles = new Map<string, Buffer | undefined>()
		for (const filePath of instructionFiles) {
			try {
				const stats = await fs.lstat(filePath)
				assert.ok(stats.isFile(), `The owned fixture path must be a regular file: ${filePath}`)
				originalFiles.set(filePath, await fs.readFile(filePath))
			} catch (error) {
				if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
				originalFiles.set(filePath, undefined)
			}
		}

		let createdGitMarker = false
		try {
			try {
				await fs.lstat(gitMarker)
			} catch (error) {
				if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
				await fs.writeFile(gitMarker, "synthetic repository marker")
				createdGitMarker = true
			}
			await fs.writeFile(ancestorStandard, "STALE ancestor standard guidance")
			await fs.writeFile(ancestorOverride, ancestorOverridePrefix)
			await fs.writeFile(ancestorLocal, "Alpha local guidance")
			await fs.writeFile(workspaceInstructions, "CWD😀tail")

			const model = new InstructionDiscoveryScriptedAI()
			const configuration: AlphaCodeSettings = {
				...globalThis.api.getConfiguration(),
				apiProvider: "fake-ai",
				fakeAi: model,
				mode: "code",
				customInstructions: "Alpha global guidance",
				autoApprovalEnabled: true,
				requestDelaySeconds: 0,
				writeDelayMs: 0,
				enableCheckpoints: false,
			}
			let taskId: string | undefined
			try {
				taskId = await globalThis.api.startNewTask({
					configuration,
					text: "Inspect the loaded project instructions.",
				})
				const provider = (
					globalThis.api as unknown as {
						sidebarProvider: {
							getLiveTask(
								taskId: string,
							): { clineMessages: Array<{ partial?: boolean; text?: string }> } | undefined
						}
					}
				).sidebarProvider
				await waitFor(() => model.requests.length === 1, {
					timeout: 30_000,
					interval: 25,
					description: "the scripted task's first provider request",
				})
				const request = model.requests[0]
				assert.ok(request, "The task must send one provider request")
				const renderedRequest = `${request.systemPrompt}\n${JSON.stringify(request.messages)}`
				assert.ok(
					renderedRequest.includes("Alpha global guidance"),
					"Alpha global instructions must still reach the model",
				)
				assert.ok(
					renderedRequest.includes(ancestorOverridePrefix),
					"The bounded ancestor override must reach the model",
				)
				assert.ok(
					renderedRequest.includes("Alpha local guidance"),
					"Alpha local instructions must survive the project cap",
				)
				assert.ok(renderedRequest.includes("CWD"), "The remaining project budget must reach cwd guidance")
				assert.ok(
					!renderedRequest.includes("CWD😀tail"),
					"The cwd instruction must truncate at the project byte cap",
				)
				assert.ok(!renderedRequest.includes("\uFFFD"), "Truncation must not introduce invalid UTF-8")
				assert.ok(
					!renderedRequest.includes("STALE ancestor standard guidance"),
					"The same-directory standard file must be shadowed",
				)
				assert.ok(
					renderedRequest.indexOf("Alpha global guidance") < renderedRequest.indexOf(ancestorOverridePrefix),
					"Alpha global instructions must retain their existing precedence before project rules",
				)
				assert.ok(
					renderedRequest.indexOf(ancestorOverridePrefix) < renderedRequest.indexOf("Alpha local guidance"),
					"Project instruction sources must be ordered from root to cwd",
				)
				assert.ok(
					renderedRequest.indexOf("Alpha local guidance") < renderedRequest.indexOf("CWD"),
					"Alpha local instructions must retain their position before cwd guidance",
				)
				await waitFor(
					() =>
						provider
							.getLiveTask(taskId!)
							?.clineMessages.some(
								(message) =>
									!message.partial && message.text === "Instruction discovery completed visibly.",
							) ?? false,
					{
						timeout: 30_000,
						interval: 25,
						description: "the final visible task response",
					},
				)
			} finally {
				if (taskId) await globalThis.api.clearCurrentTask().catch(() => undefined)
			}
		} finally {
			for (const [filePath, original] of originalFiles) {
				if (original) await fs.writeFile(filePath, original)
				else await fs.rm(filePath, { force: true })
			}
			if (createdGitMarker) await fs.rm(gitMarker, { force: true })
		}
	})
})
