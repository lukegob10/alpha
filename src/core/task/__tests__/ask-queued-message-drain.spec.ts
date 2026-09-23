import { Task } from "../Task"
import { createSubagentCommandApprovalPolicy } from "../../auto-approval/commands"

// Keep this test focused: if a queued message arrives while Task.ask() is blocked,
// it should be consumed and used to fulfill the ask.

describe("Task.ask queued message drain", () => {
	const createAskOnlyTask = async () => {
		const task = Object.create(Task.prototype) as Task
		;(task as any).abort = false
		;(task as any).taskId = "task-1"
		;(task as any).clineMessages = []
		;(task as any).askResponse = undefined
		;(task as any).askResponseText = undefined
		;(task as any).askResponseImages = undefined
		;(task as any).lastMessageTs = undefined

		const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
		;(task as any).messageQueueService = new MessageQueueService()
		;(task as any).addToAlphaMessages = vi.fn(async () => {})
		;(task as any).saveAlphaMessages = vi.fn(async () => {})
		;(task as any).updateAlphaMessage = vi.fn(async () => {})
		;(task as any).cancelAutoApprovalTimeout = vi.fn(() => {})
		;(task as any).checkpointSave = vi.fn(async () => {})
		;(task as any).emit = vi.fn()
		;(task as any).providerRef = { deref: () => undefined }
		return task
	}

	const inheritedCommandPolicy = {
		autoApprovalEnabled: true,
		alwaysAllowReadOnly: true,
		alwaysAllowReadOnlyOutsideWorkspace: false,
		alwaysAllowWrite: true,
		alwaysAllowWriteOutsideWorkspace: false,
		alwaysAllowWriteProtected: false,
		alwaysAllowExecute: true,
		alwaysAllowSubagents: true,
		commandApproval: createSubagentCommandApprovalPolicy(["git"], ["git push"], "7".repeat(64)),
	}

	it.each([
		{ taskKind: "primary", onScreen: true },
		{ taskKind: "primary", onScreen: false },
		{ taskKind: "subagent", onScreen: true },
		{ taskKind: "subagent", onScreen: false },
	])("honors command auto-approval for $taskKind tasks (on screen: $onScreen)", async ({ taskKind, onScreen }) => {
		const task = await createAskOnlyTask()
		Object.assign(task, {
			taskKind,
			subagentContextManifest: { runtimePolicy: { autoApproval: inheritedCommandPolicy } },
			providerRef: {
				deref: () => ({
					getState: async () => ({
						autoApprovalEnabled: true,
						alwaysAllowExecute: true,
						allowedCommands: ["*"],
					}),
					isTaskOnScreen: () => onScreen,
				}),
			},
		})
		const autoApprove = vi.spyOn(task, "approveAsk")
		const pending = task.ask("command", "git status", false)
		try {
			await vi.waitFor(() => expect(autoApprove).toHaveBeenCalledOnce())
			await expect(pending).resolves.toMatchObject({ response: "yesButtonClicked" })
		} finally {
			task.handleWebviewAskResponse("noButtonClicked")
			await pending
		}
	})

	it("preserves an explicit approval requirement despite wildcard auto-approval and retains the directory", async () => {
		const task = await createAskOnlyTask()
		Object.assign(task, {
			taskKind: "primary",
			providerRef: {
				deref: () => ({
					getState: async () => ({
						autoApprovalEnabled: true,
						alwaysAllowExecute: true,
						allowedCommands: ["*"],
					}),
					isTaskOnScreen: () => true,
				}),
			},
		})
		const autoApprove = vi.spyOn(task, "approveAsk")
		const pending = task.ask("command", "node script.js", false, { text: "../outside" }, false, true)
		await vi.waitFor(() => expect(task["addToAlphaMessages"]).toHaveBeenCalled())
		expect(autoApprove).not.toHaveBeenCalled()
		expect(task["addToAlphaMessages"]).toHaveBeenCalledWith(
			expect.objectContaining({ progressStatus: { text: "../outside" } }),
		)
		task.handleWebviewAskResponse("noButtonClicked")
		await expect(pending).resolves.toMatchObject({ response: "noButtonClicked" })
	})

	it("auto-approves a managed-child action despite an explicit review flag in Auto", async () => {
		const task = await createAskOnlyTask()
		;(task as any).taskKind = "subagent"
		;(task as any).subagentContextManifest = { runtimePolicy: { autoApproval: inheritedCommandPolicy } }
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => ({
					...inheritedCommandPolicy,
					allowedCommands: ["*"],
					deniedCommands: [],
				})),
				isTaskOnScreen: vi.fn(() => true),
			}),
		}

		const autoApprove = vi.spyOn(task, "approveAsk")
		const result = await task.ask(
			"tool",
			JSON.stringify({ tool: "editedExistingFile", path: "protected.txt", isOutsideWorkspace: true }),
			false,
			undefined,
			true,
			true,
		)

		expect(autoApprove).toHaveBeenCalledOnce()
		expect(result.response).toBe("yesButtonClicked")
	})

	it("keeps Ask review active even for a parent-authorized managed-child read", async () => {
		const task = await createAskOnlyTask()
		Object.assign(task, {
			taskKind: "subagent",
			subagentAuthority: { role: "review", logicalWorkspace: "F:/workspace", approvalProvenance: "group" },
			subagentContextManifest: { runtimePolicy: { autoApproval: inheritedCommandPolicy } },
		})
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => ({ approvalMode: "ask" })),
				isTaskOnScreen: vi.fn(() => true),
			}),
		}

		const autoApprove = vi.spyOn(task, "approveAsk")
		const askPromise = task.ask("tool", JSON.stringify({ tool: "readFile", path: "src/index.ts" }), false)
		await vi.waitFor(() => expect(task["addToAlphaMessages"]).toHaveBeenCalled())
		expect(autoApprove).not.toHaveBeenCalled()
		task.handleWebviewAskResponse("yesButtonClicked")

		await expect(askPromise).resolves.toMatchObject({ response: "yesButtonClicked" })
	})

	it("auto-approves a child command outside its command allowlist in Auto", async () => {
		const task = await createAskOnlyTask()
		;(task as any).taskKind = "subagent"
		;(task as any).subagentContextManifest = { runtimePolicy: { autoApproval: inheritedCommandPolicy } }
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => ({ approvalMode: "auto", allowedCommands: ["*"], deniedCommands: [] })),
				isTaskOnScreen: vi.fn(() => true),
			}),
		}

		const autoApprove = vi.spyOn(task, "approveAsk")
		const result = await task.ask("command", "pnpm test", false, undefined, false, true)

		expect(autoApprove).toHaveBeenCalledOnce()
		expect(result.response).toBe("yesButtonClicked")
	})

	it("fails closed for a retained managed child without a captured approval ceiling", async () => {
		const task = await createAskOnlyTask()
		;(task as any).taskKind = "subagent"
		;(task as any).subagentContextManifest = { runtimePolicy: {} }
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => ({
					autoApprovalEnabled: true,
					alwaysAllowExecute: true,
					allowedCommands: ["*"],
					deniedCommands: [],
				})),
				isTaskOnScreen: vi.fn(() => true),
			}),
		}

		const askPromise = task.ask("command", "pnpm test", false)
		setTimeout(() => {
			;(task as any).handleWebviewAskResponse("messageResponse", "legacy child requires approval")
		}, 0)

		await expect(askPromise).resolves.toMatchObject({
			response: "messageResponse",
			text: "legacy child requires approval",
		})
	})

	it.each(["followup", "tool", "command"] as const)(
		"does not consume queued messages while blocked on %s ask",
		async (askType) => {
			const task = await createAskOnlyTask()

			const askPromise = task.ask(askType, "Q?", false)
			;(task as any).messageQueueService.addMessage("queued next turn")

			setTimeout(() => {
				;(task as any).handleWebviewAskResponse("messageResponse", "manual response")
			}, 0)

			const result = await askPromise

			expect(result.response).toBe("messageResponse")
			expect(result.text).toBe("manual response")
			expect((task as any).messageQueueService.isEmpty()).toBe(false)
			expect((task as any).messageQueueService.messages[0]?.text).toBe("queued next turn")
		},
	)

	it("consumes queued message while blocked on completion ask", async () => {
		const task = await createAskOnlyTask()

		const askPromise = task.ask("completion_result", "Done", false)

		;(task as any).messageQueueService.addMessage("picked answer")

		const result = await askPromise
		expect(result.response).toBe("messageResponse")
		expect(result.text).toBe("picked answer")
	})

	it.each(["completion_result", "resume_task", "resume_completed_task"] as const)(
		"consumes exactly one pre-queued message in FIFO order for %s",
		async (askType) => {
			const task = await createAskOnlyTask()
			;(task as any).messageQueueService.addMessage("first queued turn")
			;(task as any).messageQueueService.addMessage("second queued turn")

			const result = await task.ask(askType, "Done", false)

			expect(result).toMatchObject({ response: "messageResponse", text: "first queued turn" })
			expect((task as any).messageQueueService.messages).toHaveLength(1)
			expect((task as any).messageQueueService.messages[0]?.text).toBe("second queued turn")
		},
	)

	it("settles a blocked ask when the task is aborted", async () => {
		const task = await createAskOnlyTask()
		const askPromise = task.ask("followup", "Q?", false)

		;(task as any).abort = true

		await expect(askPromise).rejects.toThrow("aborted")
		expect((task as any).activeAsk).toBeUndefined()
	})

	it("does not consume queued messages for command_output asks", async () => {
		const task = await createAskOnlyTask()

		const askPromise = task.ask("command_output", "command is still running...", false)
		;(task as any).messageQueueService.addMessage("1+1=?")

		setTimeout(() => {
			task.approveAsk()
		}, 0)

		const result = await askPromise

		expect(result.response).toBe("yesButtonClicked")
		expect(result.text).toBeUndefined()
		expect((task as any).messageQueueService.isEmpty()).toBe(false)
		expect((task as any).messageQueueService.messages[0]?.text).toBe("1+1=?")
	})

	it("auto-continues command output when the task is off-screen", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => false),
			}),
		}

		const result = await task.ask("command_output", "command is still running...", false)

		expect(result.response).toBe("messageResponse")
		expect(result.text).toBeUndefined()
	})

	it("auto-feeds recovery guidance for off-screen mistake-limit asks", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => false),
			}),
		}

		const result = await task.ask("mistake_limit_reached", "generic guidance", false)

		expect(result.response).toBe("messageResponse")
		expect(result.text).toContain("Continue independent authorized work where possible")
		expect(result.text).toContain("ordinary final answer")
		expect(result.text).toContain("new_task by itself")
	})

	it("auto-answers off-screen follow-up asks with the first suggestion", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => false),
			}),
		}

		const result = await task.ask(
			"followup",
			JSON.stringify({
				question: "Which path?",
				suggest: [{ answer: "Use option A" }, { answer: "Use option B" }],
			}),
			false,
		)

		expect(result.response).toBe("messageResponse")
		expect(result.text).toBe("Use option A")
	})

	it("auto-answers off-screen follow-up asks with guidance when no suggestion is available", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => false),
			}),
		}

		const result = await task.ask("followup", JSON.stringify({ question: "Which path?", suggest: [] }), false)

		expect(result.response).toBe("messageResponse")
		expect(result.text).toContain("Continue without waiting for the user")
	})

	it("auto-approves off-screen completion asks so background tasks finalize", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => false),
			}),
		}

		const result = await task.ask("completion_result", "Done", false)

		expect(result.response).toBe("yesButtonClicked")
		expect(result.text).toBeUndefined()
	})

	it.each(["resume_task", "resume_completed_task"] as const)(
		"does not auto-approve off-screen %s asks",
		async (askType) => {
			const task = await createAskOnlyTask()
			;(task as any).providerRef = {
				deref: () => ({
					getState: vi.fn(async () => undefined),
					isTaskOnScreen: vi.fn(() => false),
				}),
			}

			const askPromise = task.ask(askType, "Done", false)

			await new Promise((resolve) => setTimeout(resolve, 20))

			expect((task as any).askResponse).toBeUndefined()
			;(task as any).handleWebviewAskResponse("messageResponse", "manual response")

			const result = await askPromise

			expect(result.response).toBe("messageResponse")
			expect(result.text).toBe("manual response")
		},
	)

	it("keeps on-screen mistake-limit asks interactive", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => true),
			}),
		}

		const askPromise = task.ask("mistake_limit_reached", "generic guidance", false)

		setTimeout(() => {
			;(task as any).handleWebviewAskResponse("messageResponse", "manual guidance")
		}, 0)

		const result = await askPromise

		expect(result.response).toBe("messageResponse")
		expect(result.text).toBe("manual guidance")
	})

	it("auto-approves off-screen delegation control asks", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => false),
			}),
		}

		const result = await task.ask("tool", JSON.stringify({ tool: "newTask", mode: "Code" }), false)

		expect(result.response).toBe("yesButtonClicked")
	})

	it("auto-approves on-screen delegation control asks when auto-approval is enabled", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => ({
					autoApprovalEnabled: true,
					alwaysAllowSubtasks: false,
				})),
				isTaskOnScreen: vi.fn(() => true),
			}),
		}

		const result = await task.ask("tool", JSON.stringify({ tool: "newTask", mode: "Architect" }), false)

		expect(result.response).toBe("yesButtonClicked")
	})

	it("auto-approves on-screen asynchronous sub-agent asks when sub-agent auto-approval is enabled", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => ({
					autoApprovalEnabled: true,
					alwaysAllowSubagents: true,
					alwaysAllowReadOnly: true,
				})),
				isTaskOnScreen: vi.fn(() => true),
			}),
		}

		const result = await task.ask("tool", JSON.stringify({ tool: "spawnAgent", agent: { role: "explore" } }), false)

		expect(result.response).toBe("yesButtonClicked")
	})

	it("does not auto-approve protected off-screen tool asks", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => false),
			}),
		}

		const askPromise = task.ask("tool", JSON.stringify({ tool: "writeToFile" }), false, undefined, true)

		setTimeout(() => {
			task.approveAsk()
		}, 0)

		const result = await askPromise

		expect(result.response).toBe("yesButtonClicked")
	})
})
