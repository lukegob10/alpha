import { render, screen, act } from "@/utils/test-utils"

import {
	type ProviderSettings,
	type ExperimentId,
	type ExtensionState,
	type ClineMessage,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	agentLifecycleDegradedSignalSchema,
	agentLifecycleEventSchema,
	agentLifecycleSnapshotSchema,
	type AgentLifecycleSnapshot,
	TaskLifecycleState,
	TaskStatus,
} from "@alpha-code/types"

import { ExtensionStateContextProvider, useExtensionState, mergeExtensionState } from "../ExtensionStateContext"

const TestComponent = () => {
	const { allowedCommands, setAllowedCommands, soundEnabled, showRooIgnoredFiles, setShowRooIgnoredFiles } =
		useExtensionState()

	return (
		<div>
			<div data-testid="allowed-commands">{JSON.stringify(allowedCommands)}</div>
			<div data-testid="sound-enabled">{JSON.stringify(soundEnabled)}</div>
			<div data-testid="show-rooignored-files">{JSON.stringify(showRooIgnoredFiles)}</div>
			<button data-testid="update-button" onClick={() => setAllowedCommands(["npm install", "git status"])}>
				Update Commands
			</button>
			<button
				data-testid="toggle-alphaignore-button"
				onClick={() => setShowRooIgnoredFiles(!showRooIgnoredFiles)}>
				Update Commands
			</button>
		</div>
	)
}

const ApiConfigTestComponent = () => {
	const { apiConfiguration, setApiConfiguration } = useExtensionState()

	return (
		<div>
			<div data-testid="api-configuration">{JSON.stringify(apiConfiguration)}</div>
			<button
				data-testid="update-api-config-button"
				onClick={() => setApiConfiguration({ apiModelId: "new-model", apiProvider: "anthropic" })}>
				Update API Config
			</button>
			<button data-testid="partial-update-button" onClick={() => setApiConfiguration({ modelTemperature: 0.7 })}>
				Partial Update
			</button>
		</div>
	)
}

const MessagesTestComponent = () => {
	const { clineMessages } = useExtensionState()
	return (
		<>
			<div data-testid="latest-message">{clineMessages.at(-1)?.text ?? ""}</div>
			<div data-testid="all-messages">{clineMessages.map((message) => message.text).join("|")}</div>
		</>
	)
}

const WelcomeStateTestComponent = () => {
	const { showWelcome, currentTaskId } = useExtensionState()
	return (
		<>
			<div data-testid="show-welcome">{String(showWelcome)}</div>
			<div data-testid="current-task-id">{currentTaskId ?? ""}</div>
		</>
	)
}

const dispatchExtensionState = (state: Partial<ExtensionState>) => {
	window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } }))
}

const LifecycleStateTestComponent = () => {
	const { agentLifecycleSnapshots, agentLifecycleDegraded, liveTasksById, liveTaskIds } = useExtensionState()
	const snapshot = agentLifecycleSnapshots?.["lifecycle-task"]
	const metadata = liveTasksById?.["lifecycle-task"]
	return (
		<>
			<div data-testid="lifecycle-snapshot-status">{snapshot?.status ?? ""}</div>
			<div data-testid="lifecycle-snapshot-phase">{snapshot?.phase ?? ""}</div>
			<div data-testid="lifecycle-task-state">{metadata?.lifecycle ?? ""}</div>
			<div data-testid="lifecycle-task-status">{metadata?.status ?? ""}</div>
			<div data-testid="lifecycle-task-waiting">{String(metadata?.isWaitingForInput ?? false)}</div>
			<div data-testid="lifecycle-degraded">{String(Boolean(agentLifecycleDegraded?.["lifecycle-task"]))}</div>
			<div data-testid="lifecycle-live-task-ids">{(liveTaskIds ?? []).join(",")}</div>
		</>
	)
}

const makeLifecycleEvent = (eventId: string, sequence: number, phase: "working" | "waiting") =>
	agentLifecycleEventSchema.parse({
		version: 1,
		eventId,
		sequence,
		taskId: "lifecycle-task",
		runId: "lifecycle-run",
		turnId: "lifecycle-turn",
		occurredAt: sequence,
		type: "phase_changed",
		payload: { phase },
	})

const makeLifecycleSnapshot = (overrides: Partial<AgentLifecycleSnapshot> = {}) =>
	agentLifecycleSnapshotSchema.parse({
		version: 1,
		taskId: "lifecycle-task",
		runId: "lifecycle-run",
		turnId: "lifecycle-turn",
		status: "in_progress",
		phase: "working",
		lastSequence: 1,
		items: [],
		steps: [],
		acceptedToolCallIds: [],
		terminalToolCallIds: [],
		processedEvents: [{ eventId: "event-1", sequence: 1, fingerprint: "event-1" }],
		...overrides,
	})

const makeLifecycleDegradedSignal = (degraded: boolean) =>
	agentLifecycleDegradedSignalSchema.parse({
		version: 1,
		taskId: "lifecycle-task",
		degraded,
		reason: degraded ? "append_rejected" : "resynced",
		occurredAt: degraded ? 10 : 11,
	})

describe("ExtensionStateContext", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("initializes with empty allowedCommands array", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("allowed-commands").textContent!)).toEqual([])
	})

	it("initializes with soundEnabled set to false", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("sound-enabled").textContent!)).toBe(false)
	})

	it("initializes with showRooIgnoredFiles set to true", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("show-rooignored-files").textContent!)).toBe(true)
	})

	it("updates showRooIgnoredFiles through setShowRooIgnoredFiles", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			screen.getByTestId("toggle-alphaignore-button").click()
		})

		expect(JSON.parse(screen.getByTestId("show-rooignored-files").textContent!)).toBe(false)
	})

	it("updates allowedCommands through setAllowedCommands", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			screen.getByTestId("update-button").click()
		})

		expect(JSON.parse(screen.getByTestId("allowed-commands").textContent!)).toEqual(["npm install", "git status"])
	})

	it("throws error when used outside provider", () => {
		// Suppress console.error for this test since we expect an error
		const consoleSpy = vi.spyOn(console, "error")
		consoleSpy.mockImplementation(() => {})

		expect(() => {
			render(<TestComponent />)
		}).toThrow("useExtensionState must be used within an ExtensionStateContextProvider")

		consoleSpy.mockRestore()
	})

	it("updates apiConfiguration through setApiConfiguration", () => {
		render(
			<ExtensionStateContextProvider>
				<ApiConfigTestComponent />
			</ExtensionStateContextProvider>,
		)

		const initialContent = screen.getByTestId("api-configuration").textContent!
		expect(initialContent).toBeDefined()

		act(() => {
			screen.getByTestId("update-api-config-button").click()
		})

		const updatedContent = screen.getByTestId("api-configuration").textContent!
		const updatedConfig = JSON.parse(updatedContent || "{}")

		expect(updatedConfig).toEqual(
			expect.objectContaining({
				apiModelId: "new-model",
				apiProvider: "anthropic",
			}),
		)
	})

	it("correctly merges partial updates to apiConfiguration", () => {
		render(
			<ExtensionStateContextProvider>
				<ApiConfigTestComponent />
			</ExtensionStateContextProvider>,
		)

		// First set the initial configuration
		act(() => {
			screen.getByTestId("update-api-config-button").click()
		})

		// Verify initial update
		const initialContent = screen.getByTestId("api-configuration").textContent!
		const initialConfig = JSON.parse(initialContent || "{}")
		expect(initialConfig).toEqual(
			expect.objectContaining({
				apiModelId: "new-model",
				apiProvider: "anthropic",
			}),
		)

		// Now perform a partial update
		act(() => {
			screen.getByTestId("partial-update-button").click()
		})

		// Verify that the partial update was merged with the existing configuration
		const updatedContent = screen.getByTestId("api-configuration").textContent!
		const updatedConfig = JSON.parse(updatedContent || "{}")
		expect(updatedConfig).toEqual(
			expect.objectContaining({
				apiModelId: "new-model", // Should retain this from previous update
				apiProvider: "anthropic", // Should retain this from previous update
				modelTemperature: 0.7, // Should add this from partial update
			}),
		)
	})

	it("does not replace an established chat with provider setup during partial state updates", () => {
		render(
			<ExtensionStateContextProvider>
				<WelcomeStateTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			dispatchExtensionState({
				apiConfiguration: { apiProvider: "openai-codex" },
				currentTaskId: "task-1",
				currentView: { type: "task", taskId: "task-1" },
				taskStateSeq: 1,
			})
		})

		expect(screen.getByTestId("show-welcome")).toHaveTextContent("false")
		expect(screen.getByTestId("current-task-id")).toHaveTextContent("task-1")

		act(() => {
			// Queue and todo fast paths intentionally omit apiConfiguration.
			dispatchExtensionState({ currentTaskId: "task-1", messageQueue: [], messageQueueSeq: 2 })
			dispatchExtensionState({ currentTaskId: "task-1", currentTaskTodos: [], currentTaskTodosSeq: 2 })
		})

		expect(screen.getByTestId("show-welcome")).toHaveTextContent("false")

		act(() => {
			// A provider-only refresh is also not allowed to cover the established task.
			dispatchExtensionState({ apiConfiguration: {} })
		})

		expect(screen.getByTestId("show-welcome")).toHaveTextContent("false")

		act(() => {
			// Even a temporarily incomplete full provider snapshot cannot cover an active task.
			dispatchExtensionState({
				apiConfiguration: {},
				currentTaskId: "task-1",
				currentView: { type: "task", taskId: "task-1" },
				taskStateSeq: 2,
			})
		})

		expect(screen.getByTestId("show-welcome")).toHaveTextContent("false")
	})

	it("opens provider setup only for an unconfigured new-task draft", () => {
		render(
			<ExtensionStateContextProvider>
				<WelcomeStateTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			dispatchExtensionState({ apiConfiguration: {}, currentView: { type: "newTaskDraft" }, taskStateSeq: 1 })
		})

		expect(screen.getByTestId("show-welcome")).toHaveTextContent("true")

		act(() => {
			dispatchExtensionState({ apiConfiguration: { apiProvider: "openai-codex" } })
		})

		expect(screen.getByTestId("show-welcome")).toHaveTextContent("false")
	})

	it("never infers missing provider setup from an initial queue fast-path", () => {
		render(
			<ExtensionStateContextProvider>
				<WelcomeStateTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			dispatchExtensionState({ currentTaskId: "task-1", messageQueueSeq: 1, messageQueue: [] })
		})
		expect(screen.getByTestId("show-welcome")).toHaveTextContent("false")

		act(() => {
			dispatchExtensionState({
				apiConfiguration: {},
				currentTaskId: "task-1",
				currentView: { type: "task", taskId: "task-1" },
				taskStateSeq: 1,
				messageQueueSeq: 2,
			})
		})
		expect(screen.getByTestId("show-welcome")).toHaveTextContent("false")
	})

	it("hides setup immediately when a fresh active-task fast-path overtakes a draft snapshot", () => {
		render(
			<ExtensionStateContextProvider>
				<WelcomeStateTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			dispatchExtensionState({
				apiConfiguration: {},
				currentView: { type: "newTaskDraft" },
				taskStateSeq: 1,
				messageQueueSeq: 1,
			})
		})
		expect(screen.getByTestId("show-welcome")).toHaveTextContent("true")

		act(() => {
			dispatchExtensionState({ currentTaskId: "task-2", messageQueueSeq: 2, messageQueue: [] })
		})
		expect(screen.getByTestId("show-welcome")).toHaveTextContent("false")

		act(() => {
			// A stale lifecycle snapshot must not clear the newer fast-path signal.
			dispatchExtensionState({
				apiConfiguration: {},
				currentView: { type: "newTaskDraft" },
				taskStateSeq: 1,
			})
		})
		expect(screen.getByTestId("show-welcome")).toHaveTextContent("false")
	})

	it("coalesces partial message updates per animation frame and applies completion immediately", () => {
		let frameCallback: FrameRequestCallback | undefined
		vi.stubGlobal(
			"requestAnimationFrame",
			vi.fn((callback: FrameRequestCallback) => {
				frameCallback = callback
				return 1
			}),
		)
		vi.stubGlobal("cancelAnimationFrame", vi.fn())

		const baseMessage: ClineMessage = {
			ts: 1,
			type: "say",
			say: "text",
			text: "start",
			partial: true,
		}
		render(
			<ExtensionStateContextProvider>
				<MessagesTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "state",
						state: { currentTaskId: "task-1", clineMessages: [baseMessage] },
					},
				}),
			)
		})

		act(() => {
			for (const text of ["first", "latest"]) {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "messageUpdated",
							taskId: "task-1",
							clineMessage: { ...baseMessage, text },
						},
					}),
				)
			}
		})

		expect(screen.getByTestId("latest-message")).toHaveTextContent("start")
		expect(requestAnimationFrame).toHaveBeenCalledTimes(1)

		act(() => frameCallback?.(0))
		expect(screen.getByTestId("latest-message")).toHaveTextContent("latest")

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "messageUpdated",
						taskId: "task-1",
						clineMessage: { ...baseMessage, text: "queued" },
					},
				}),
			)
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "messageUpdated",
						taskId: "task-1",
						clineMessage: { ...baseMessage, text: "complete", partial: false },
					},
				}),
			)
		})

		expect(screen.getByTestId("latest-message")).toHaveTextContent("complete")
		act(() => frameCallback?.(0))
		expect(screen.getByTestId("latest-message")).toHaveTextContent("complete")
	})

	it("applies interleaved partial updates in wire-sequence order", () => {
		let frameCallback: FrameRequestCallback | undefined
		vi.stubGlobal(
			"requestAnimationFrame",
			vi.fn((callback: FrameRequestCallback) => {
				frameCallback = callback
				return 1
			}),
		)
		vi.stubGlobal("cancelAnimationFrame", vi.fn())
		const first: ClineMessage = { ts: 1, type: "say", say: "reasoning", text: "first", partial: true }
		const second: ClineMessage = { ts: 2, type: "say", say: "text", text: "second", partial: true }

		render(
			<ExtensionStateContextProvider>
				<MessagesTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "state",
						state: { currentTaskId: "task-1", clineMessages: [first, second], clineMessagesSeq: 1 },
					},
				}),
			)
			for (const data of [
				{ clineMessage: { ...first, text: "first-1" }, clineMessagesSeq: 2 },
				{ clineMessage: { ...second, text: "second-1" }, clineMessagesSeq: 3 },
				{ clineMessage: { ...first, text: "first-2" }, clineMessagesSeq: 4 },
			]) {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "messageUpdated", taskId: "task-1", ...data },
					}),
				)
			}
		})

		act(() => frameCallback?.(0))
		expect(screen.getByTestId("all-messages")).toHaveTextContent("first-2|second-1")
	})

	it("appends new messages incrementally and rejects stale transcript snapshots", () => {
		const baseMessage: ClineMessage = { ts: 1, type: "say", say: "text", text: "start" }
		const createdMessage: ClineMessage = { ts: 2, type: "say", say: "text", text: "created" }

		render(
			<ExtensionStateContextProvider>
				<MessagesTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "state",
						state: { currentTaskId: "task-1", clineMessages: [baseMessage], clineMessagesSeq: 1 },
					},
				}),
			)
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "messageCreated",
						taskId: "task-1",
						clineMessage: createdMessage,
						clineMessagesSeq: 3,
					},
				}),
			)
			// This full transcript was started before the incremental message and must
			// not erase it if its slower state assembly finishes later.
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "state",
						state: { currentTaskId: "task-1", clineMessages: [baseMessage], clineMessagesSeq: 2 },
					},
				}),
			)
		})

		expect(screen.getByTestId("latest-message")).toHaveTextContent("created")
	})

	it("ignores stale incremental messages and replaces duplicate creations idempotently", () => {
		const baseMessage: ClineMessage = { ts: 1, type: "say", say: "text", text: "current" }

		render(
			<ExtensionStateContextProvider>
				<MessagesTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "state",
						state: { currentTaskId: "task-1", clineMessages: [baseMessage], clineMessagesSeq: 5 },
					},
				}),
			)
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "messageCreated",
						taskId: "task-1",
						clineMessage: { ...baseMessage, text: "stale" },
						clineMessagesSeq: 4,
					},
				}),
			)
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "messageCreated",
						taskId: "task-1",
						clineMessage: { ...baseMessage, text: "replacement" },
						clineMessagesSeq: 6,
					},
				}),
			)
		})

		expect(screen.getByTestId("latest-message")).toHaveTextContent("replacement")
	})
})

describe("mergeExtensionState", () => {
	it("should correctly merge extension states", () => {
		const baseState: ExtensionState = {
			version: "",
			mcpEnabled: false,
			clineMessages: [],
			taskHistory: [],
			shouldShowAnnouncement: false,
			enableCheckpoints: true,
			writeDelayMs: 1000,
			maxConcurrentTasks: 3,
			mode: "default",
			experiments: {} as Record<ExperimentId, boolean>,
			customModes: [],
			maxOpenTabsContext: 20,
			maxWorkspaceFiles: 100,
			apiConfiguration: { providerId: "openrouter" } as ProviderSettings,
			telemetrySetting: "unset",
			showRooIgnoredFiles: true,
			enableSubfolderRules: false,
			renderContext: "sidebar",
			autoCondenseContext: true,
			autoCondenseContextPercent: 100,
			profileThresholds: {},
			hasOpenedModeSelector: false, // Add the new required property
			maxImageFileSize: 5,
			maxTotalImageSize: 20,
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS, // Add the checkpoint timeout property
			maxReadFileLine: -1,
		}

		const prevState: ExtensionState = {
			...baseState,
			apiConfiguration: { modelMaxTokens: 1234, modelMaxThinkingTokens: 123 },
			experiments: {} as Record<ExperimentId, boolean>,
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS - 5,
		}

		const newState: ExtensionState = {
			...baseState,
			apiConfiguration: { modelMaxThinkingTokens: 456, modelTemperature: 0.3 },
			experiments: {
				preventFocusDisruption: false,
				imageGeneration: false,
				runSlashCommand: false,
				customTools: false,
			} as Record<ExperimentId, boolean>,
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS + 5,
		}

		const result = mergeExtensionState(prevState, newState)

		expect(result.apiConfiguration).toEqual({
			modelMaxThinkingTokens: 456,
			modelTemperature: 0.3,
		})

		expect(result.experiments).toEqual({
			preventFocusDisruption: false,
			imageGeneration: false,
			runSlashCommand: false,
			customTools: false,
		})
	})

	describe("task state sequence protection", () => {
		const baseState: ExtensionState = {
			version: "",
			mcpEnabled: false,
			clineMessages: [],
			taskHistory: [],
			shouldShowAnnouncement: false,
			enableCheckpoints: true,
			writeDelayMs: 1000,
			maxConcurrentTasks: 3,
			mode: "default",
			experiments: {} as Record<ExperimentId, boolean>,
			customModes: [],
			maxOpenTabsContext: 20,
			maxWorkspaceFiles: 100,
			apiConfiguration: {},
			telemetrySetting: "unset",
			showRooIgnoredFiles: true,
			enableSubfolderRules: false,
			renderContext: "sidebar",
			autoCondenseContext: true,
			autoCondenseContextPercent: 100,
			profileThresholds: {},
			hasOpenedModeSelector: false,
			maxImageFileSize: 5,
			maxTotalImageSize: 20,
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
			maxReadFileLine: -1,
		}

		const makeMessage = (ts: number, text: string): ClineMessage =>
			({ ts, type: "say", say: "text", text }) as ClineMessage

		it("rejects stale clineMessages when seq is not newer", () => {
			const newerMessages = [makeMessage(1, "hello"), makeMessage(2, "world")]
			const staleMessages = [makeMessage(1, "hello")]

			const prevState: ExtensionState = {
				...baseState,
				clineMessages: newerMessages,
				clineMessagesSeq: 5,
			}

			const result = mergeExtensionState(prevState, {
				clineMessages: staleMessages,
				clineMessagesSeq: 3, // stale seq
			})

			// Should keep the newer messages
			expect(result.clineMessages).toBe(newerMessages)
			expect(result.clineMessagesSeq).toBe(5)
		})

		it("does not reopen a completed task when its stale view snapshot arrives after a new-task draft", () => {
			const draftMessages: ClineMessage[] = []
			const prevState: ExtensionState = {
				...baseState,
				clineMessages: draftMessages,
				clineMessagesSeq: 5,
				currentTaskId: undefined,
				currentView: { type: "newTaskDraft" },
				currentTaskItem: undefined,
			}

			const result = mergeExtensionState(prevState, {
				clineMessages: [makeMessage(1, "completed task")],
				clineMessagesSeq: 4,
				currentTaskId: "completed-task",
				currentView: { type: "task", taskId: "completed-task" },
				currentTaskItem: {
					id: "completed-task",
					number: 1,
					ts: 1,
					task: "completed task",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			})

			expect(result.currentView).toEqual({ type: "newTaskDraft" })
			expect(result.currentTaskId).toBeUndefined()
			expect(result.currentTaskItem).toBeUndefined()
			expect(result.clineMessages).toBe(draftMessages)
			expect(result.clineMessagesSeq).toBe(5)
		})

		it("rejects clineMessages when seq equals current (not strictly greater)", () => {
			const currentMessages = [makeMessage(1, "hello"), makeMessage(2, "world")]
			const sameSeqMessages = [makeMessage(1, "hello")]

			const prevState: ExtensionState = {
				...baseState,
				clineMessages: currentMessages,
				clineMessagesSeq: 5,
			}

			const result = mergeExtensionState(prevState, {
				clineMessages: sameSeqMessages,
				clineMessagesSeq: 5, // same seq, not strictly greater
			})

			expect(result.clineMessages).toBe(currentMessages)
			expect(result.clineMessagesSeq).toBe(5)
		})

		it("accepts clineMessages when seq is strictly greater", () => {
			const oldMessages = [makeMessage(1, "hello")]
			const newMessages = [makeMessage(1, "hello"), makeMessage(2, "world")]

			const prevState: ExtensionState = {
				...baseState,
				clineMessages: oldMessages,
				clineMessagesSeq: 3,
			}

			const result = mergeExtensionState(prevState, {
				clineMessages: newMessages,
				clineMessagesSeq: 4, // newer seq
			})

			expect(result.clineMessages).toBe(newMessages)
			expect(result.clineMessagesSeq).toBe(4)
		})

		it("preserves clineMessages when newState does not include them (cloud event path)", () => {
			const existingMessages = [makeMessage(1, "hello"), makeMessage(2, "world")]

			const prevState: ExtensionState = {
				...baseState,
				clineMessages: existingMessages,
				clineMessagesSeq: 5,
			}

			// Simulate a cloud event push that omits clineMessages and clineMessagesSeq
			const result = mergeExtensionState(prevState, {})

			expect(result.clineMessages).toBe(existingMessages)
			expect(result.clineMessagesSeq).toBe(5)
		})

		it("applies clineMessages normally when neither state has seq (backward compat)", () => {
			const oldMessages = [makeMessage(1, "hello")]
			const newMessages = [makeMessage(1, "hello"), makeMessage(2, "world")]

			const prevState: ExtensionState = {
				...baseState,
				clineMessages: oldMessages,
			}

			const result = mergeExtensionState(prevState, {
				clineMessages: newMessages,
			})

			expect(result.clineMessages).toBe(newMessages)
		})

		it("applies clineMessages when prevState has no seq but newState does (first push)", () => {
			const prevState: ExtensionState = {
				...baseState,
				clineMessages: [],
			}

			const newMessages = [makeMessage(1, "hello")]
			const result = mergeExtensionState(prevState, {
				clineMessages: newMessages,
				clineMessagesSeq: 1,
			})

			expect(result.clineMessages).toBe(newMessages)
			expect(result.clineMessagesSeq).toBe(1)
		})

		it("applies lifecycle and queue updates by independent sequence domains", () => {
			const currentMessages = [makeMessage(1, "current transcript")]
			const prevState: ExtensionState = {
				...baseState,
				currentTaskId: "task-1",
				currentView: { type: "task", taskId: "task-1" },
				clineMessages: currentMessages,
				clineMessagesSeq: 10,
				taskStateSeq: 4,
				messageQueue: [{ id: "old", text: "old queue", images: [], timestamp: 1 }],
				messageQueueSeq: 2,
				liveTaskIds: ["task-1"],
				liveTasksById: {
					"task-1": {
						id: "task-1",
						status: TaskStatus.Running,
						lifecycle: TaskLifecycleState.Running,
						isActive: true,
						isStreaming: false,
						isWaitingForInput: false,
						lastUpdatedAt: 1,
						queueCount: 0,
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
					},
				},
			}

			const afterQueue = mergeExtensionState(prevState, {
				currentTaskId: "task-1",
				messageQueue: [{ id: "new", text: "new queue", images: [], timestamp: 2 }],
				messageQueueSeq: 8,
			})
			const afterLifecycle = mergeExtensionState(afterQueue, {
				currentTaskId: "task-1",
				currentView: { type: "task", taskId: "task-1" },
				taskStateSeq: 5,
				liveTaskIds: ["task-1"],
				liveTasksById: {
					"task-1": {
						...prevState.liveTasksById!["task-1"],
						lifecycle: TaskLifecycleState.Waiting,
						isWaitingForInput: true,
						waitingReason: "completion",
					},
				},
				clineMessages: [makeMessage(1, "stale transcript")],
				clineMessagesSeq: 9,
				messageQueue: [{ id: "stale", text: "stale queue", images: [], timestamp: 3 }],
				messageQueueSeq: 7,
			})

			expect(afterLifecycle.clineMessages).toBe(currentMessages)
			expect(afterLifecycle.messageQueue?.map((message) => message.text)).toEqual(["new queue"])
			expect(afterLifecycle.liveTasksById?.["task-1"]).toMatchObject({
				lifecycle: "waiting",
				isWaitingForInput: true,
				waitingReason: "completion",
			})
			expect(afterLifecycle.taskStateSeq).toBe(5)
			expect(afterLifecycle.messageQueueSeq).toBe(8)
		})

		it("ignores a queue-only patch scoped to a task that is no longer visible", () => {
			const currentQueue = [{ id: "current", text: "current queue", images: [], timestamp: 1 }]
			const prevState: ExtensionState = {
				...baseState,
				currentTaskId: "task-2",
				currentView: { type: "task", taskId: "task-2" },
				messageQueue: currentQueue,
				taskStateSeq: 10,
				messageQueueSeq: 5,
			}

			const result = mergeExtensionState(prevState, {
				currentTaskId: "task-1",
				messageQueue: [{ id: "stale", text: "wrong task", images: [], timestamp: 2 }],
				messageQueueSeq: 6,
			})

			expect(result.currentTaskId).toBe("task-2")
			expect(result.messageQueue).toBe(currentQueue)
			expect(result.messageQueueSeq).toBe(5)
		})

		it("accepts the first dedicated queue sequence after legacy shared sequencing", () => {
			const prevState: ExtensionState = {
				...baseState,
				currentTaskId: "task-1",
				currentView: { type: "task", taskId: "task-1" },
				clineMessagesSeq: 20,
				messageQueue: [],
			}

			const result = mergeExtensionState(prevState, {
				currentTaskId: "task-1",
				messageQueue: [{ id: "new", text: "first dedicated queue", images: [], timestamp: 1 }],
				messageQueueSeq: 1,
			})

			expect(result.messageQueue?.map((message) => message.text)).toEqual(["first dedicated queue"])
			expect(result.messageQueueSeq).toBe(1)
			expect(result.clineMessagesSeq).toBe(20)
		})
	})

	it("consumes lifecycle events and projects their state into live task metadata", () => {
		render(
			<ExtensionStateContextProvider>
				<LifecycleStateTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "agentLifecycleEvent",
						taskId: "lifecycle-task",
						payload: makeLifecycleEvent("event-1", 1, "working"),
					},
				}),
			)
		})

		expect(screen.getByTestId("lifecycle-snapshot-status")).toHaveTextContent("in_progress")
		expect(screen.getByTestId("lifecycle-task-state")).toHaveTextContent("running")
		expect(screen.getByTestId("lifecycle-task-status")).toHaveTextContent("running")
		expect(screen.getByTestId("lifecycle-live-task-ids")).toHaveTextContent("lifecycle-task")

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "agentLifecycleEvent",
						taskId: "lifecycle-task",
						payload: makeLifecycleEvent("event-2", 2, "waiting"),
					},
				}),
			)
		})

		expect(screen.getByTestId("lifecycle-snapshot-phase")).toHaveTextContent("waiting")
		expect(screen.getByTestId("lifecycle-task-state")).toHaveTextContent("waiting")
		expect(screen.getByTestId("lifecycle-task-status")).toHaveTextContent("interactive")
		expect(screen.getByTestId("lifecycle-task-waiting")).toHaveTextContent("true")
	})

	it("applies snapshot messages and ignores delayed snapshots that would roll state back", () => {
		render(
			<ExtensionStateContextProvider>
				<LifecycleStateTestComponent />
			</ExtensionStateContextProvider>,
		)

		const completed = makeLifecycleSnapshot({
			status: "completed",
			phase: "finalizing",
			lastSequence: 3,
			terminalEventId: "event-3",
			terminalAt: 3,
			processedEvents: [
				{ eventId: "event-1", sequence: 1, fingerprint: "event-1" },
				{ eventId: "event-2", sequence: 2, fingerprint: "event-2" },
				{ eventId: "event-3", sequence: 3, fingerprint: "event-3" },
			],
		})

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "agentLifecycleSnapshot", taskId: "lifecycle-task", payload: completed },
				}),
			)
		})

		expect(screen.getByTestId("lifecycle-snapshot-status")).toHaveTextContent("completed")
		expect(screen.getByTestId("lifecycle-task-state")).toHaveTextContent("completed")
		expect(screen.getByTestId("lifecycle-task-status")).toHaveTextContent("idle")
		expect(screen.getByTestId("lifecycle-live-task-ids")).toBeEmptyDOMElement()

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "state",
						state: { agentLifecycleSnapshots: { "lifecycle-task": makeLifecycleSnapshot() } },
					},
				}),
			)
		})

		expect(screen.getByTestId("lifecycle-snapshot-status")).toHaveTextContent("completed")
		expect(screen.getByTestId("lifecycle-task-state")).toHaveTextContent("completed")
	})

	it("falls back immediately on a degraded signal and restores canonical state after resync", () => {
		render(
			<ExtensionStateContextProvider>
				<LifecycleStateTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			dispatchExtensionState({
				currentTaskId: "lifecycle-task",
				currentView: { type: "task", taskId: "lifecycle-task" },
				clineMessages: [{ ts: 1, type: "say", say: "text", text: "legacy work" } as ClineMessage],
				liveTaskIds: ["lifecycle-task"],
				liveTasksById: {
					"lifecycle-task": {
						id: "lifecycle-task",
						status: TaskStatus.Running,
						lifecycle: TaskLifecycleState.Running,
						isActive: true,
						isStreaming: true,
						isWaitingForInput: false,
						lastUpdatedAt: 1,
						queueCount: 0,
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
					},
				},
			})
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "agentLifecycleSnapshot",
						taskId: "lifecycle-task",
						payload: makeLifecycleSnapshot({
							status: "completed",
							phase: "finalizing",
							terminalEventId: "event-2",
							terminalAt: 2,
							lastSequence: 2,
							processedEvents: [
								{ eventId: "event-1", sequence: 1, fingerprint: "event-1" },
								{ eventId: "event-2", sequence: 2, fingerprint: "event-2" },
							],
						}),
					},
				}),
			)
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "agentLifecycleDegraded",
						taskId: "lifecycle-task",
						payload: makeLifecycleDegradedSignal(true),
					},
				}),
			)
		})

		expect(screen.getByTestId("lifecycle-degraded")).toHaveTextContent("true")
		expect(screen.getByTestId("lifecycle-task-state")).toHaveTextContent("running")
		expect(screen.getByTestId("lifecycle-live-task-ids")).toHaveTextContent("lifecycle-task")

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "agentLifecycleDegraded",
						taskId: "lifecycle-task",
						payload: makeLifecycleDegradedSignal(false),
					},
				}),
			)
		})

		expect(screen.getByTestId("lifecycle-degraded")).toHaveTextContent("false")
		expect(screen.getByTestId("lifecycle-task-state")).toHaveTextContent("completed")
		expect(screen.getByTestId("lifecycle-live-task-ids")).toBeEmptyDOMElement()
	})

	it("ignores lifecycle envelopes whose aliases conflict", () => {
		render(
			<ExtensionStateContextProvider>
				<LifecycleStateTestComponent />
			</ExtensionStateContextProvider>,
		)
		const working = makeLifecycleEvent("event-1", 1, "working")
		const waiting = makeLifecycleEvent("event-1", 1, "waiting")
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "agentLifecycleEvent",
						taskId: "lifecycle-task",
						payload: working,
						agentLifecycleEvent: waiting,
					},
				}),
			)
		})
		expect(screen.getByTestId("lifecycle-snapshot-status")).toBeEmptyDOMElement()
		expect(screen.getByTestId("lifecycle-live-task-ids")).toBeEmptyDOMElement()
	})
})
