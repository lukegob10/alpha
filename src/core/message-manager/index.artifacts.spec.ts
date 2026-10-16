import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AlphaMessage } from "@alpha-code/types"

import { MessageManager } from "./index"
import { Task } from "../task/Task"
import type { ApiMessage } from "../task-persistence/apiMessages"
import * as condenseModule from "../condense"
import { MessageQueueService } from "../message-queue/MessageQueueService"

const retainedUiId = "f5a8b79e-1f3a-4d2c-a3df-9a7d6b8e2c10"
const retainedApiId = "714aeb9b-744b-4fd9-862b-17a20e9fb785"
const retainedInputId = "129a89f9-2b4b-47ea-9140-6011a19b489d"
const removedId = "cf3fd315-9756-4133-82d2-d54b5e8dd6f8"
const untrackedId = "4333157f-4c91-4cab-a826-18a36b3dabf3"
const artifactName = (id: string) => `cmd-${id}.txt`

describe("rewind command artifact retention", () => {
	let directory: string
	let artifactDirectory: string
	let task: Task
	let manager: MessageManager
	let filenames: string[]

	beforeEach(async () => {
		vi.spyOn(condenseModule, "cleanupAfterTruncation").mockImplementation((messages) => messages)
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-rewind-artifacts-"))
		artifactDirectory = path.join(directory, "tasks", "rewind-artifacts", "command-output")
		await fs.mkdir(artifactDirectory, { recursive: true })
		filenames = [
			artifactName("100"),
			artifactName("500"),
			artifactName(retainedUiId),
			artifactName(retainedApiId),
			artifactName(retainedInputId),
			artifactName(removedId),
			artifactName(untrackedId),
			"cmd-unrecognized.txt",
			"notes.txt",
		]
		await Promise.all(filenames.map((name) => fs.writeFile(path.join(artifactDirectory, name), `retained ${name}`)))
		task = {
			taskId: "rewind-artifacts",
			globalStoragePath: directory,
			abort: false,
			isTurnActive: vi.fn(() => false),
			hasActiveCommandExecutions: vi.fn(() => false),
			hasPendingSteerMessage: vi.fn(() => false),
			clineMessages: [
				{ ts: 100, type: "ask", ask: "command", text: "git diff" },
				{ ts: 200, type: "say", say: "command_output", text: `Artifact ID: ${artifactName(retainedUiId)}` },
				{ ts: 400, type: "say", say: "text", text: "Remove the following work" },
				{ ts: 500, type: "say", say: "command_output", text: `Artifact ID: ${artifactName(removedId)}` },
			],
			apiConversationHistory: [
				{ ts: 100, role: "user", content: "Inspect command output" },
				{
					ts: 210,
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "saved-read",
							name: "write_stdin",
							input: { artifact_id: artifactName(retainedInputId) },
						},
					],
				},
				{
					ts: 220,
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "saved-read",
							content: [{ type: "text", text: `Read ${artifactName(retainedApiId)}` }],
						},
					],
				},
				{ ts: 400, role: "user", content: "Removed instruction" },
				{ ts: 500, role: "assistant", content: `Removed ${artifactName(removedId)}` },
			],
			overwriteAlphaMessages: vi.fn(async (messages: AlphaMessage[]) => {
				task.clineMessages = messages
				return true
			}),
			overwriteApiConversationHistory: vi.fn(async (messages: ApiMessage[]) => {
				task.apiConversationHistory = messages
				return true
			}),
		} as unknown as Task
		manager = new MessageManager(task)
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("preserves retained UI and API references and removes only committed rewind candidates", async () => {
		await manager.rewindToTimestamp(400)

		expect((await fs.readdir(artifactDirectory)).sort()).toEqual(
			filenames.filter((name) => ![artifactName("500"), artifactName(removedId)].includes(name)).sort(),
		)
	})

	it.each(["ui", "api"] as const)("keeps artifacts when the %s transcript save returns false", async (source) => {
		if (source === "ui") {
			vi.mocked(task.overwriteAlphaMessages).mockImplementation(async (messages) => {
				task.clineMessages = messages
				return false
			})
		} else {
			vi.mocked(task.overwriteApiConversationHistory).mockImplementation(async (messages) => {
				task.apiConversationHistory = messages
				return false
			})
		}

		await manager.rewindToTimestamp(400)

		expect((await fs.readdir(artifactDirectory)).sort()).toEqual([...filenames].sort())
	})

	it.each(["ui", "api"] as const)("waits for the %s transcript receipt before deleting artifacts", async (source) => {
		let release!: (saved: boolean) => void
		const receipt = new Promise<boolean>((resolve) => {
			release = resolve
		})
		let started!: () => void
		const saving = new Promise<void>((resolve) => {
			started = resolve
		})
		if (source === "ui") {
			vi.mocked(task.overwriteAlphaMessages).mockImplementation(async (messages) => {
				task.clineMessages = messages
				started()
				return receipt
			})
		} else {
			vi.mocked(task.overwriteApiConversationHistory).mockImplementation(async (messages) => {
				task.apiConversationHistory = messages
				started()
				return receipt
			})
		}
		const rewind = manager.rewindToTimestamp(400)
		await saving
		const beforeCommit = await fs.readdir(artifactDirectory)
		release(true)
		await rewind

		expect(beforeCommit.sort()).toEqual([...filenames].sort())
		expect(await fs.readdir(artifactDirectory)).not.toContain(artifactName(removedId))
	})

	it.each([false, true])(
		"requires a new API receipt after an earlier failed save (retry saved: %s)",
		async (saved) => {
			task.clineMessages = [
				{ ts: 100, type: "say", say: "text", text: "Original task" },
				{ ts: 200, type: "say", say: "command_output", text: `Artifact ID: ${artifactName(removedId)}` },
				{ ts: 400, type: "say", say: "text", text: "Rewind here first" },
			]
			task.apiConversationHistory = [
				{ ts: 100, role: "user", content: "Original task" },
				{ ts: 400, role: "user", content: `Read ${artifactName(removedId)}` },
			]
			let durableHistory = structuredClone(task.apiConversationHistory)
			vi.mocked(task.overwriteApiConversationHistory)
				.mockImplementationOnce(async (messages) => {
					task.apiConversationHistory = messages
					return false
				})
				.mockImplementationOnce(async (messages) => {
					task.apiConversationHistory = messages
					if (saved) durableHistory = structuredClone(messages)
					return saved
				})

			await manager.rewindToTimestamp(400)
			expect(task.apiConversationHistory).toHaveLength(1)
			expect(durableHistory).toHaveLength(2)
			expect(await fs.readdir(artifactDirectory)).toContain(artifactName(removedId))
			await manager.rewindToTimestamp(200)

			expect(task.overwriteApiConversationHistory).toHaveBeenCalledTimes(2)
			expect(durableHistory).toHaveLength(saved ? 1 : 2)
			expect((await fs.readdir(artifactDirectory)).includes(artifactName(removedId))).toBe(!saved)
		},
	)

	it("preserves artifacts for legacy overwrite implementations without a commit receipt", async () => {
		vi.mocked(task.overwriteAlphaMessages).mockImplementation(async (messages) => {
			task.clineMessages = messages
			return undefined as unknown as boolean
		})
		await manager.rewindToTimestamp(400)
		expect((await fs.readdir(artifactDirectory)).sort()).toEqual([...filenames].sort())
	})

	it("preserves artifacts when rewind cleanup is explicitly skipped", async () => {
		await manager.rewindToTimestamp(400, { skipCleanup: true })
		expect((await fs.readdir(artifactDirectory)).sort()).toEqual([...filenames].sort())
	})

	it.each(["text", "reasoning_content", "reasoning_details", "summary"] as const)(
		"retains references in historical API %s fields",
		async (field) => {
			const reference = `Historical artifact ${artifactName(removedId)}`
			Object.assign(task.apiConversationHistory[0], {
				[field]: field === "text" || field === "reasoning_content" ? reference : [{ text: reference }],
			})
			await manager.rewindToTimestamp(400)
			expect(await fs.readdir(artifactDirectory)).toContain(artifactName(removedId))
		},
	)

	it.each(["ui", "api"] as const)("keeps artifacts when the %s transcript save rejects", async (source) => {
		if (source === "ui") vi.mocked(task.overwriteAlphaMessages).mockRejectedValue(new Error("save failed"))
		else vi.mocked(task.overwriteApiConversationHistory).mockRejectedValue(new Error("save failed"))

		await expect(manager.rewindToTimestamp(400)).rejects.toThrow("save failed")

		expect((await fs.readdir(artifactDirectory)).sort()).toEqual([...filenames].sort())
	})

	it.each(["turn", "command", "pending input", "aborting"] as const)(
		"keeps artifacts while %s work may still own them",
		async (active) => {
			if (active === "turn") vi.mocked(task.isTurnActive).mockReturnValue(true)
			else if (active === "command") vi.mocked(task.hasActiveCommandExecutions).mockReturnValue(true)
			else if (active === "pending input") vi.mocked(task.hasPendingSteerMessage).mockReturnValue(true)
			else task.abort = true

			await manager.rewindToTimestamp(400)

			expect((await fs.readdir(artifactDirectory)).sort()).toEqual([...filenames].sort())
		},
	)

	it.each(["reference", "turn", "command", "pending input", "aborting"] as const)(
		"checks current %s admission after the cleanup directory read",
		async (change) => {
			const originalReaddir = fs.readdir.bind(fs)
			let release!: () => void
			const directoryBarrier = new Promise<void>((resolve) => {
				release = resolve
			})
			let entered!: () => void
			const reading = new Promise<void>((resolve) => {
				entered = resolve
			})
			vi.spyOn(fs, "readdir").mockImplementationOnce(async () => {
				const files = await originalReaddir(artifactDirectory)
				entered()
				await directoryBarrier
				return files as unknown as Awaited<ReturnType<typeof fs.readdir>>
			})
			const rewind = manager.rewindToTimestamp(400)
			await reading
			if (change === "reference") {
				task.apiConversationHistory.push({
					ts: 600,
					role: "user",
					content: `Read ${artifactName(removedId)} again`,
				})
			} else if (change === "turn") vi.mocked(task.isTurnActive).mockReturnValue(true)
			else if (change === "command") vi.mocked(task.hasActiveCommandExecutions).mockReturnValue(true)
			else if (change === "pending input") vi.mocked(task.hasPendingSteerMessage).mockReturnValue(true)
			else task.abort = true
			release()
			await rewind

			expect(await fs.readdir(artifactDirectory)).toContain(artifactName(removedId))
		},
	)

	it("preserves artifacts during real queue admission before input becomes visible", async () => {
		let releaseAdmission!: () => void
		const admissionBarrier = new Promise<void>((resolve) => {
			releaseAdmission = resolve
		})
		let saving!: () => void
		const admissionStarted = new Promise<void>((resolve) => {
			saving = resolve
		})
		const queue = new MessageQueueService({
			load: async () => [],
			save: async () => {
				saving()
				await admissionBarrier
			},
		})
		Object.assign(task, { messageQueueService: queue })
		await queue.ready
		const originalReaddir = fs.readdir.bind(fs)
		let releaseDirectory!: () => void
		const directoryBarrier = new Promise<void>((resolve) => {
			releaseDirectory = resolve
		})
		let reading!: () => void
		const directoryStarted = new Promise<void>((resolve) => {
			reading = resolve
		})
		vi.spyOn(fs, "readdir").mockImplementationOnce(async () => {
			const files = await originalReaddir(artifactDirectory)
			reading()
			await directoryBarrier
			return files as unknown as Awaited<ReturnType<typeof fs.readdir>>
		})
		const rewind = manager.rewindToTimestamp(400)
		await directoryStarted
		const admission = queue.addMessageDurably(`Read ${artifactName(removedId)} again`)
		await admissionStarted
		const pendingState = {
			visible: queue.visibleMessages,
			unconsumed: queue.hasUnconsumedInput(),
			active: task.isTurnActive(),
			steering: task.hasPendingSteerMessage(),
		}
		releaseDirectory()
		try {
			await rewind
		} finally {
			releaseAdmission()
			await admission
			queue.dispose()
		}

		expect(pendingState).toEqual({ visible: [], unconsumed: true, active: false, steering: false })
		expect(await fs.readdir(artifactDirectory)).toContain(artifactName(removedId))
	})

	it("checks references added while a prior artifact unlink is pending", async () => {
		const originalUnlink = fs.unlink.bind(fs)
		let release!: () => void
		const unlinkBarrier = new Promise<void>((resolve) => {
			release = resolve
		})
		let entered!: () => void
		const unlinking = new Promise<void>((resolve) => {
			entered = resolve
		})
		vi.spyOn(fs, "readdir").mockResolvedValueOnce([
			artifactName("500"),
			artifactName(removedId),
		] as unknown as Awaited<ReturnType<typeof fs.readdir>>)
		vi.spyOn(fs, "unlink").mockImplementationOnce(async (file) => {
			await originalUnlink(file)
			entered()
			await unlinkBarrier
		})
		const rewind = manager.rewindToTimestamp(400)
		await unlinking
		task.clineMessages.push({ ts: 600, type: "say", say: "text", text: `Retain ${artifactName(removedId)}` })
		release()
		await rewind

		expect(await fs.readdir(artifactDirectory)).toContain(artifactName(removedId))
	})

	it("preserves artifacts created while transcript replacement is committing", async () => {
		const newer = "cmd-600.txt"
		vi.mocked(task.overwriteApiConversationHistory).mockImplementation(async (messages) => {
			await fs.writeFile(path.join(artifactDirectory, newer), "newly produced command output")
			task.apiConversationHistory = messages
			return true
		})

		await manager.rewindToTimestamp(400)

		expect(await fs.readFile(path.join(artifactDirectory, newer), "utf8")).toBe("newly produced command output")
	})

	it("preserves candidate artifacts referenced again during the API commit", async () => {
		vi.mocked(task.overwriteApiConversationHistory).mockImplementation(async (messages) => {
			task.apiConversationHistory = [
				...messages,
				{ ts: 600, role: "assistant", content: `Keep ${artifactName(removedId)}` },
			]
			return true
		})
		await manager.rewindToTimestamp(400)
		expect(await fs.readdir(artifactDirectory)).toContain(artifactName(removedId))
	})

	it.each([true, false])("returns the actual UI save receipt %s", async (saved) => {
		Object.assign(task, {
			invalidateBackgroundUsageDrain: vi.fn(),
			observeUiMessageTimestamps: Task.prototype["observeUiMessageTimestamps"],
			saveAlphaMessages: vi.fn(async () => saved),
		})

		expect(await Task.prototype.overwriteAlphaMessages.call(task, [])).toBe(saved)
	})
})
