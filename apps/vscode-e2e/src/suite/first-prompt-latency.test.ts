import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"

import type { AlphaMessage, ProviderSettings } from "@alpha-code/types"

import { withBoundedFixtureCleanup } from "./proportional-context-support"
import { waitFor } from "./utils"

interface StartupTask {
	taskId: string
	didComplete: boolean
	clineMessages: AlphaMessage[]
	start(): void
}

interface StartupHost {
	createTask(
		text: string,
		images: undefined,
		parent: undefined,
		options: {
			startTask: false
			preserveExisting: true
			presentationModelCalls: false
			apiConfiguration: ProviderSettings
		},
	): Promise<StartupTask>
}

interface StartupSpan {
	phase: string
	startedMs: number
	durationMs: number
}

/** Preserve the production method's synchronous/async boundary while observing its duration. */
function observeMethod(owner: object, name: string, began: number, spans: StartupSpan[]): () => void {
	const original: unknown = Reflect.get(owner, name)
	assert.equal(typeof original, "function", `Missing startup boundary: ${name}`)
	const method = original as (...args: unknown[]) => unknown
	Reflect.set(owner, name, function (this: object, ...args: unknown[]) {
		const start = performance.now()
		const record = () =>
			spans.push({ phase: name, startedMs: start - began, durationMs: performance.now() - start })
		try {
			const result = method.apply(this, args)
			if (result instanceof Promise) return result.finally(record)
			record()
			return result
		} catch (error) {
			record()
			throw error
		}
	})
	return () => Reflect.set(owner, name, original)
}

suite("First prompt admission latency", function () {
	this.timeout(120_000)

	test("measures task creation, visible input and first provider dispatch with production preflight", async () => {
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const artifactsDir = process.env.ALPHA_E2E_ARTIFACTS_DIR
		assert.ok(artifactsDir)
		const api = globalThis.api
		const originalConfiguration = api.getConfiguration()
		const host = (api as unknown as { sidebarProvider: StartupHost }).sidebarProvider
		const samples: object[] = []
		let began = 0
		let firstRequestMs: number | undefined
		const scripted = {
			id: "first-prompt-fixture",
			async *createMessage() {
				firstRequestMs ??= performance.now() - began
				yield { type: "text" as const, text: "The startup fixture is complete." }
			},
			getModel() {
				return { id: this.id, info: { contextWindow: 128_000, maxTokens: 4096 } }
			},
			async countTokens() {
				return 1
			},
			async completePrompt() {
				return ""
			},
			removeFromCache: undefined as (() => void) | undefined,
		}

		await withBoundedFixtureCleanup(async () => {
			await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
			await api.setConfiguration({
				...originalConfiguration,
				apiProvider: "fake-ai",
				fakeAi: scripted,
				mode: "code",
				approvalMode: "ask",
				requestDelaySeconds: 0,
			})
			for (let sample = 0; sample < 3; sample++) {
				const spans: StartupSpan[] = []
				const restore: (() => unknown)[] = []
				firstRequestMs = undefined
				began = performance.now()
				try {
					for (const name of ["getState", "getSkillsManager", "postTaskStateToWebview", "addTaskToStack"]) {
						restore.push(observeMethod(host, name, began, spans))
					}
					const task = await host.createTask("Reply briefly to this startup check.", undefined, undefined, {
						startTask: false,
						preserveExisting: true,
						presentationModelCalls: false,
						apiConfiguration: { apiProvider: "fake-ai", fakeAi: scripted },
					})
					const taskCreatedMs = performance.now() - began
					for (const name of [
						"say",
						"getSystemPrompt",
						"prepareCapturedReasoning",
						"saveApiConversationHistory",
					]) {
						restore.push(observeMethod(task, name, began, spans))
					}
					task.start()
					await waitFor(() => task.didComplete, {
						description: "startup fixture completion",
						timeout: 30_000,
					})
					assert.ok(firstRequestMs !== undefined, "The initial prompt must reach the provider")
					assert.ok(task.clineMessages.some((message) => message.say === "completion_result"))
					samples.push({ sample, taskCreatedMs, firstRequestMs, spans })
				} finally {
					for (const cleanup of restore.reverse()) cleanup()
					await api.clearCurrentTask()
				}
			}
			const report = {
				schemaVersion: 1,
				hostVersion: vscode.version,
				provider: "scripted",
				boundary:
					"host task creation to injected provider entry; composer transport and renderer paint excluded",
				conditions: "fresh task/catalog per sample; same workspace/process; warm filesystem caches; no pacing",
				samples,
			}
			await fs.writeFile(path.join(artifactsDir, "first-prompt-latency.json"), JSON.stringify(report, null, 2), {
				flag: "wx",
			})
			console.log(`[first-prompt-latency] ${JSON.stringify(report)}`)
		}, [
			() => api.clearCurrentTask(),
			() => scripted.removeFromCache?.(),
			() => api.setConfiguration(originalConfiguration),
		])
	})
})
