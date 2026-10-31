import { render, screen, act, fireEvent } from "@/utils/test-utils"

import {
	type ProviderSettings,
	type ExperimentId,
	type ExtensionState,
	type AlphaMessage,
	type LiveTaskMetadata,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	agentLifecycleDegradedSignalSchema,
	agentLifecycleEventSchema,
	agentLifecycleSnapshotSchema,
	type AgentLifecycleSnapshot,
	TaskLifecycleState,
	TaskStatus,
} from "@alpha-code/types"

import {
	ExtensionStateContextProvider,
	useExtensionState,
	useShellState,
	mergeExtensionState,
} from "../ExtensionStateContext"

const TicketApprovalTestComponent = () => {
	const { setAlwaysAllowTickets, alwaysAllowTickets } = useExtensionState()
	return <button onClick={() => setAlwaysAllowTickets(!alwaysAllowTickets)}>{String(alwaysAllowTickets)}</button>
}

const ApprovalModeTestComponent = () => {
	const { approvalMode } = useExtensionState()
	return <div data-testid="global-approval-mode">{approvalMode}</div>
}

const TestComponent = () => {
	const { allowedCommands, setAllowedCommands, soundEnabled, showAlphaIgnoredFiles, setShowAlphaIgnoredFiles } =
		useExtensionState()

	return (
		<div>
			<div data-testid="allowed-commands">{JSON.stringify(allowedCommands)}</div>
			<div data-testid="sound-enabled">{JSON.stringify(soundEnabled)}</div>
			<div data-testid="show-alphaignored-files">{JSON.stringify(showAlphaIgnoredFiles)}</div>
			<button data-testid="update-button" onClick={() => setAllowedCommands(["npm install", "git status"])}>
				Update Commands
			</button>
			<button
				data-testid="toggle-alphaignore-button"
				onClick={() => setShowAlphaIgnoredFiles(!showAlphaIgnoredFiles)}>
				Update Commands
			</button>
		</div>
	)
}

const ReasoningPreferenceTestComponent = () => {
	const { reasoningBlockCollapsed } = useExtensionState()
	return <div data-testid="reasoning-block-collapsed">{String(reasoningBlockCollapsed)}</div>
}

const AutoSteerPreferenceTestComponent = () => {
	const { autoSteer } = useExtensionState()
	return <div data-testid="auto-steer">{String(autoSteer)}</div>
}

const ApiConfigTestComponent = () => {
	const { apiConfiguration, setApiConfiguration } = useExtensionState()

	return (
		<div>
			<div data-testid="api-configuration">{JSON.stringify(apiConfiguration)}</div>
			<button
				data-testid="update-api-config-button"
				onClick={() => setApiConfiguration({ apiModelId: "new-model", apiProvider: "vertex" })}>
				Update API Config
			</button>
			<button data-testid="partial-update-button" onClick={() => setApiConfiguration({ modelTemperature: 0.7 })}>
				Partial Update
			</button>
		</div>
	)
}

const MessagesTestComponent = () => {
	const { alphaMessages } = useExtensionState()
	return (
		<>
			<div data-testid="latest-message">{alphaMessages.at(-1)?.text ?? ""}</div>
			<div data-testid="all-messages">{alphaMessages.map((message) => message.text).join("|")}</div>
		</>
	)
}

const BackgroundActivityTestComponent = () => {
	const { alphaMessages, liveTasksById } = useExtensionState()
	return (
		<>
			<div data-testid="foreground-message-count">{alphaMessages.length}</div>
			<div data-testid="background-activity">{liveTasksById?.["task-2"]?.lastUpdatedAt ?? 0}</div>
			<div data-testid="background-context">{liveTasksById?.["task-2"]?.model?.info.contextWindow ?? 0}</div>
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

	it("leaves saved defaults unchanged when the composer receives an approval-cycle shortcut", () => {
		render(
			<ExtensionStateContextProvider>
				<ApprovalModeTestComponent />
			</ExtensionStateContextProvider>,
		)
		act(() => dispatchExtensionState({ approvalMode: "ask" }))
		fireEvent(window, new MessageEvent("message", { data: { type: "action", action: "toggleAutoApprove" } }))
		expect(screen.getByTestId("global-approval-mode")).toHaveTextContent("ask")
	})

	it("defaults new-install Auto ticket approval on and hydrates leftover off, toggles, and reloads", () => {
		const view = (
			<ExtensionStateContextProvider>
				<TicketApprovalTestComponent />
			</ExtensionStateContextProvider>
		)
		const { unmount } = render(view)
		expect(screen.getByRole("button")).toHaveTextContent("true")
		act(() => dispatchExtensionState({ alwaysAllowTickets: false }))
		expect(screen.getByRole("button")).toHaveTextContent("false")
		act(() => dispatchExtensionState({ alwaysAllowTickets: true }))
		expect(screen.getByRole("button")).toHaveTextContent("true")
		fireEvent.click(screen.getByRole("button"))
		expect(screen.getByRole("button")).toHaveTextContent("false")

		unmount()
		render(view)
		act(() => dispatchExtensionState({ alwaysAllowTickets: true }))
		expect(screen.getByRole("button")).toHaveTextContent("true")
		act(() => dispatchExtensionState({ alwaysAllowTickets: false }))
		expect(screen.getByRole("button")).toHaveTextContent("false")
	})

	it("initializes with empty allowedCommands array", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("allowed-commands").textContent!)).toEqual([])
	})

	it("defaults reasoning traces to collapsed and preserves an explicit expanded preference", () => {
		render(
			<ExtensionStateContextProvider>
				<ReasoningPreferenceTestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(screen.getByTestId("reasoning-block-collapsed")).toHaveTextContent("true")
		act(() => dispatchExtensionState({ reasoningBlockCollapsed: false }))
		expect(screen.getByTestId("reasoning-block-collapsed")).toHaveTextContent("false")
	})

	it("defaults to queuing and hydrates explicit automatic steering preferences", () => {
		render(
			<ExtensionStateContextProvider>
				<AutoSteerPreferenceTestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(screen.getByTestId("auto-steer")).toHaveTextContent("false")
		act(() => dispatchExtensionState({ autoSteer: true }))
		expect(screen.getByTestId("auto-steer")).toHaveTextContent("true")
		act(() => dispatchExtensionState({ soundEnabled: true }))
		expect(screen.getByTestId("auto-steer")).toHaveTextContent("true")
		act(() => dispatchExtensionState({ autoSteer: false }))
		expect(screen.getByTestId("auto-steer")).toHaveTextContent("false")
	})

	it("initializes with soundEnabled set to false", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("sound-enabled").textContent!)).toBe(false)
	})

	it("initializes with showAlphaIgnoredFiles set to true", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("show-alphaignored-files").textContent!)).toBe(true)
	})

	it("updates showAlphaIgnoredFiles through setShowAlphaIgnoredFiles", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			screen.getByTestId("toggle-alphaignore-button").click()
		})

		expect(JSON.parse(screen.getByTestId("show-alphaignored-files").textContent!)).toBe(false)
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
				apiProvider: "vertex",
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
				apiProvider: "vertex",
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
				apiProvider: "vertex", // Should retain this from previous update
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
				apiConfiguration: { apiProvider: "vscode-lm", vsCodeLmModelSelector: { id: "fixture-model" } },
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
			dispatchExtensionState({ apiConfiguration: { apiProvider: "ollama" } })
		})
		expect(screen.getByTestId("show-welcome")).toHaveTextContent("true")

		act(() => {
			dispatchExtensionState({
				apiConfiguration: { apiProvider: "vscode-lm", vsCodeLmModelSelector: { id: "fixture-model" } },
			})
		})

		expect(screen.getByTestId("show-welcome")).toHaveTextContent("false")
	})

	it.each(["openai-codex", "bedrock"] as const)(
		"keeps a configured %s draft out of initial provider setup",
		(apiProvider) => {
			render(
				<ExtensionStateContextProvider>
					<WelcomeStateTestComponent />
				</ExtensionStateContextProvider>,
			)

			act(() => {
				dispatchExtensionState({
					apiConfiguration: { apiProvider },
					currentView: { type: "newTaskDraft" },
					taskStateSeq: 1,
				})
			})

			expect(screen.getByTestId("show-welcome")).toHaveTextContent("false")
		},
	)

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

		const baseMessage: AlphaMessage = {
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
						state: { currentTaskId: "task-1", alphaMessages: [baseMessage] },
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
							alphaMessage: { ...baseMessage, text },
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
						alphaMessage: { ...baseMessage, text: "queued" },
					},
				}),
			)
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "messageUpdated",
						taskId: "task-1",
						alphaMessage: { ...baseMessage, text: "complete", partial: false },
					},
				}),
			)
		})

		expect(screen.getByTestId("latest-message")).toHaveTextContent("complete")
		act(() => frameCallback?.(0))
		expect(screen.getByTestId("latest-message")).toHaveTextContent("complete")
	})

	it("preserves legacy transcript wire creation, streaming, completion, and sequence ordering", () => {
		let frameCallback: FrameRequestCallback | undefined
		vi.stubGlobal(
			"requestAnimationFrame",
			vi.fn((callback: FrameRequestCallback) => {
				frameCallback = callback
				return 1
			}),
		)
		vi.stubGlobal("cancelAnimationFrame", vi.fn())
		let state: ReturnType<typeof useExtensionState> | undefined
		const CaptureState = () => {
			state = useExtensionState()
			return null
		}
		const publish = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data }))
		const prompt: AlphaMessage = { ts: 1, type: "say", say: "user_feedback", text: "Please help" }
		const response: AlphaMessage = { ts: 2, type: "say", say: "text", text: "start", partial: true }
		render(
			<ExtensionStateContextProvider>
				<CaptureState />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			publish({
				type: "state",
				state: { currentTaskId: "task-1", clineMessages: [], clineMessagesSeq: 10 },
			})
			publish({ type: "messageCreated", taskId: "task-1", clineMessage: prompt, clineMessagesSeq: 11 })
		})
		expect(state?.alphaMessages).toEqual([prompt])
		expect(state?.alphaMessagesSeq).toBe(11)

		act(() => {
			publish({ type: "messageCreated", taskId: "task-1", clineMessage: response, clineMessagesSeq: 12 })
			for (const [clineMessagesSeq, text] of [
				[13, "first"],
				[15, "newest"],
				[14, "older"],
			] as const) {
				publish({
					type: "messageUpdated",
					taskId: "task-1",
					clineMessage: { ...response, text },
					clineMessagesSeq,
				})
			}
		})
		act(() => frameCallback?.(0))
		expect(state?.alphaMessages).toEqual([prompt, { ...response, text: "newest" }])
		expect(state?.alphaMessagesSeq).toBe(15)

		const completed = { ...response, text: "complete", partial: false }
		act(() => {
			publish({
				type: "messageUpdated",
				taskId: "task-1",
				clineMessage: { ...response, text: "queued" },
				clineMessagesSeq: 16,
			})
			publish({ type: "messageUpdated", taskId: "task-1", clineMessage: completed, clineMessagesSeq: 17 })
			publish({
				type: "state",
				state: { currentTaskId: "task-1", clineMessages: [prompt], clineMessagesSeq: 16 },
			})
			publish({ type: "messageCreated", taskId: "task-1", clineMessage: prompt, clineMessagesSeq: 16 })
		})
		act(() => frameCallback?.(0))
		expect(state?.alphaMessages).toEqual([prompt, completed])
		expect(state?.alphaMessagesSeq).toBe(17)
	})

	it("restores legacy transcript wire snapshots without accepting older revisions", () => {
		let state: ReturnType<typeof useExtensionState> | undefined
		const CaptureState = () => {
			state = useExtensionState()
			return null
		}
		const message: AlphaMessage = { ts: 1, type: "say", say: "text", text: "saved conversation" }
		render(
			<ExtensionStateContextProvider>
				<CaptureState />
			</ExtensionStateContextProvider>,
		)
		act(() => {
			for (const [clineMessagesSeq, clineMessages] of [
				[7, [message]],
				[6, []],
			] as const) {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "state", state: { currentTaskId: "task-1", clineMessages, clineMessagesSeq } },
					}),
				)
			}
		})
		expect(state?.alphaMessages).toEqual([message])
		expect(state?.alphaMessagesSeq).toBe(7)
	})

	it("prefers canonical transcript wire fields when legacy aliases are also present", () => {
		let state: ReturnType<typeof useExtensionState> | undefined
		const CaptureState = () => {
			state = useExtensionState()
			return null
		}
		const canonical: AlphaMessage = { ts: 1, type: "say", say: "text", text: "canonical" }
		const legacy: AlphaMessage = { ...canonical, text: "legacy" }
		render(
			<ExtensionStateContextProvider>
				<CaptureState />
			</ExtensionStateContextProvider>,
		)
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "state",
						state: {
							currentTaskId: "task-1",
							alphaMessages: [canonical],
							alphaMessagesSeq: 20,
							clineMessages: [legacy],
							clineMessagesSeq: 100,
						},
					},
				}),
			)
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "messageUpdated",
						taskId: "task-1",
						alphaMessage: { ...canonical, text: "canonical update" },
						alphaMessagesSeq: 21,
						clineMessage: { ...legacy, text: "legacy update" },
						clineMessagesSeq: 101,
					},
				}),
			)
		})
		expect(state?.alphaMessages).toEqual([{ ...canonical, text: "canonical update" }])
		expect(state?.alphaMessagesSeq).toBe(21)
	})

	it.each(["messageCreated", "messageUpdated"])(
		"ignores malformed incremental %s payloads without corrupting the transcript",
		(type) => {
			let state: ReturnType<typeof useExtensionState> | undefined
			const CaptureState = () => {
				state = useExtensionState()
				return null
			}
			const errors: unknown[] = []
			const captureError = (event: ErrorEvent) => {
				errors.push(event.error)
				event.preventDefault()
			}
			window.addEventListener("error", captureError)
			try {
				render(
					<ExtensionStateContextProvider>
						<CaptureState />
					</ExtensionStateContextProvider>,
				)
				act(() => dispatchExtensionState({ currentTaskId: "task-1", alphaMessages: [], alphaMessagesSeq: 1 }))
				const previous = state
				for (const payload of [{}, { alphaMessage: null }, { alphaMessage: 7 }]) {
					act(() => {
						window.dispatchEvent(
							new MessageEvent("message", {
								data: { type, taskId: "task-1", alphaMessagesSeq: 2, ...payload },
							}),
						)
					})
					expect(state).toBe(previous)
					expect(state?.alphaMessages).toEqual([])
				}
				expect(errors).toEqual([])
			} finally {
				window.removeEventListener("error", captureError)
			}
		},
	)

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
		const first: AlphaMessage = { ts: 1, type: "say", say: "reasoning", text: "first", partial: true }
		const second: AlphaMessage = { ts: 2, type: "say", say: "text", text: "second", partial: true }

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
						state: { currentTaskId: "task-1", alphaMessages: [first, second], alphaMessagesSeq: 1 },
					},
				}),
			)
			for (const data of [
				{ alphaMessage: { ...first, text: "first-1" }, alphaMessagesSeq: 2 },
				{ alphaMessage: { ...second, text: "second-1" }, alphaMessagesSeq: 3 },
				{ alphaMessage: { ...first, text: "first-2" }, alphaMessagesSeq: 4 },
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

	it("retains the newest partial when an older update arrives before the animation frame", () => {
		let frameCallback: FrameRequestCallback | undefined
		vi.stubGlobal(
			"requestAnimationFrame",
			vi.fn((callback: FrameRequestCallback) => {
				frameCallback = callback
				return 1
			}),
		)
		vi.stubGlobal("cancelAnimationFrame", vi.fn())
		const message: AlphaMessage = { ts: 1, type: "say", say: "text", text: "start", partial: true }
		render(
			<ExtensionStateContextProvider>
				<MessagesTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			dispatchExtensionState({ currentTaskId: "task-1", alphaMessages: [message], alphaMessagesSeq: 1 })
			for (const [alphaMessagesSeq, text] of [
				[3, "newest"],
				[2, "older"],
			] as const) {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "messageUpdated",
							taskId: "task-1",
							alphaMessagesSeq,
							alphaMessage: { ...message, text },
						},
					}),
				)
			}
		})

		act(() => frameCallback?.(0))
		expect(screen.getByTestId("latest-message")).toHaveTextContent("newest")
	})

	it.each(["messageCreated", "messageUpdated"])(
		"does not let a stale %s reopen a completed chat through tied activity metadata",
		(type) => {
			const message: AlphaMessage = { ts: 1, type: "say", say: "text", text: "complete" }
			const completed = {
				id: "lifecycle-task",
				status: TaskStatus.Idle,
				lifecycle: TaskLifecycleState.Completed,
				isActive: true,
				isStreaming: false,
				isWaitingForInput: false,
				lastUpdatedAt: 100,
				queueCount: 0,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			}
			render(
				<ExtensionStateContextProvider>
					<LifecycleStateTestComponent />
				</ExtensionStateContextProvider>,
			)

			act(() => {
				dispatchExtensionState({
					currentTaskId: "lifecycle-task",
					alphaMessages: [message],
					alphaMessagesSeq: 10,
					liveTasksById: { "lifecycle-task": completed },
				})
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type,
							taskId: "lifecycle-task",
							alphaMessagesSeq: 9,
							alphaMessage: { ...message, text: "older" },
							liveTask: {
								...completed,
								status: TaskStatus.Running,
								lifecycle: TaskLifecycleState.Running,
								isStreaming: true,
							},
						},
					}),
				)
			})

			expect(screen.getByTestId("lifecycle-task-state")).toHaveTextContent(TaskLifecycleState.Completed)
		},
	)

	it.each([
		["messageCreated", 11],
		["messageCreated", 12],
		["messageUpdated", 11],
		["messageUpdated", 12],
	])("keeps background completion across %s at transcript revision %s", (type, staleRevision) => {
		const completed = {
			id: "lifecycle-task",
			transcriptRevision: 12,
			status: TaskStatus.Idle,
			lifecycle: TaskLifecycleState.Completed,
			isActive: false,
			isStreaming: false,
			isWaitingForInput: false,
			lastUpdatedAt: 100,
			queueCount: 0,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const publishIncremental = (transcriptRevision: number, alphaMessagesSeq: number) => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type,
						taskId: "lifecycle-task",
						alphaMessagesSeq,
						alphaMessage: { ts: 2, type: "say", say: "text", text: "background" },
						liveTask: {
							...completed,
							transcriptRevision,
							status: TaskStatus.Running,
							lifecycle: TaskLifecycleState.Running,
							isStreaming: true,
						},
					},
				}),
			)
		}
		render(
			<ExtensionStateContextProvider>
				<LifecycleStateTestComponent />
				<MessagesTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			dispatchExtensionState({
				currentTaskId: "foreground-task",
				alphaMessages: [{ ts: 1, type: "say", say: "text", text: "foreground" }],
				alphaMessagesSeq: 100,
				liveTasksById: { "lifecycle-task": completed },
			})
			publishIncremental(staleRevision, 99)
		})
		expect(screen.getByTestId("lifecycle-task-state")).toHaveTextContent(TaskLifecycleState.Completed)

		act(() => publishIncremental(13, 101))
		expect(screen.getByTestId("lifecycle-task-state")).toHaveTextContent(TaskLifecycleState.Running)
		expect(screen.getByTestId("all-messages")).toHaveTextContent("foreground")
	})

	it("appends new messages incrementally and rejects stale transcript snapshots", () => {
		const baseMessage: AlphaMessage = { ts: 1, type: "say", say: "text", text: "start" }
		const createdMessage: AlphaMessage = { ts: 2, type: "say", say: "text", text: "created" }

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
						state: { currentTaskId: "task-1", alphaMessages: [baseMessage], alphaMessagesSeq: 1 },
					},
				}),
			)
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "messageCreated",
						taskId: "task-1",
						alphaMessage: createdMessage,
						alphaMessagesSeq: 3,
					},
				}),
			)
			// This full transcript was started before the incremental message and must
			// not erase it if its slower state assembly finishes later.
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "state",
						state: { currentTaskId: "task-1", alphaMessages: [baseMessage], alphaMessagesSeq: 2 },
					},
				}),
			)
		})

		expect(screen.getByTestId("latest-message")).toHaveTextContent("created")
	})

	it("updates background task activity without replacing the visible transcript", () => {
		const foregroundMessage: AlphaMessage = { ts: 1, type: "say", say: "text", text: "foreground" }
		render(
			<ExtensionStateContextProvider>
				<BackgroundActivityTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			dispatchExtensionState({
				currentTaskId: "task-1",
				alphaMessages: [foregroundMessage],
			})
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "messageCreated",
						taskId: "task-2",
						alphaMessage: { ts: 2, type: "say", say: "text", text: "background" },
						liveTask: {
							id: "task-2",
							model: {
								id: "copilot-claude-opus-4.7",
								info: {
									contextWindow: 935_793,
									supportsPromptCache: false,
									contextWindowIncludesOutput: false,
								},
							},
							status: "running",
							lifecycle: "running",
							isActive: false,
							isStreaming: true,
							isTurnActive: true,
							canInterrupt: true,
							isWaitingForInput: false,
							lastUpdatedAt: 20,
							queueCount: 0,
							tokensIn: 0,
							tokensOut: 0,
							totalCost: 0,
						},
					},
				}),
			)
		})

		expect(screen.getByTestId("foreground-message-count")).toHaveTextContent("1")
		expect(screen.getByTestId("background-activity")).toHaveTextContent("20")
		expect(screen.getByTestId("background-context")).toHaveTextContent("935793")
	})

	it("applies a background task batch atomically without mutating the previous snapshot", () => {
		let frameCallback: FrameRequestCallback | undefined
		vi.stubGlobal(
			"requestAnimationFrame",
			vi.fn((callback: FrameRequestCallback) => {
				frameCallback = callback
				return 1
			}),
		)
		vi.stubGlobal("cancelAnimationFrame", vi.fn())
		const snapshots: ReturnType<typeof useExtensionState>[] = []
		const StateProbe = () => {
			snapshots.push(useExtensionState())
			return null
		}
		const makeLiveTask = (id: string, transcriptRevision: number): LiveTaskMetadata => ({
			id,
			transcriptRevision,
			status: TaskStatus.Running,
			lifecycle: TaskLifecycleState.Running,
			isActive: false,
			isStreaming: true,
			isWaitingForInput: false,
			lastUpdatedAt: transcriptRevision,
			queueCount: 0,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		})
		const liveTasksById = Object.fromEntries(
			Array.from({ length: 32 }, (_, index) => {
				const id = `background-${index}`
				return [id, makeLiveTask(id, 1)]
			}),
		)
		render(
			<ExtensionStateContextProvider>
				<StateProbe />
			</ExtensionStateContextProvider>,
		)
		act(() => {
			dispatchExtensionState({
				currentTaskId: "foreground-task",
				alphaMessages: [{ ts: 1, type: "say", say: "text", text: "foreground" }],
				alphaMessagesSeq: 1_000,
				liveTasksById,
			})
		})
		const previous = snapshots.at(-1)!
		Object.freeze(previous.liveTasksById)
		const rendersBeforeBatch = snapshots.length
		const publish = (ts: number, alphaMessagesSeq: number, liveTask: LiveTaskMetadata) => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "messageUpdated",
						taskId: liveTask.id,
						alphaMessage: { ts, type: "say", say: "text", text: "background", partial: true },
						alphaMessagesSeq,
						liveTask,
					},
				}),
			)
		}
		act(() => {
			Object.keys(liveTasksById).forEach((taskId, index) => {
				publish(100 + index, index + 2, makeLiveTask(taskId, 2))
			})
			publish(200, 34, makeLiveTask("background-0", 3))
			publish(201, 35, { ...makeLiveTask("background-0", 2), lastUpdatedAt: 1_000 })
			publish(202, 36, { ...makeLiveTask("background-0", 3), lastUpdatedAt: 1_001 })
		})
		expect(snapshots).toHaveLength(rendersBeforeBatch)
		expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
		act(() => frameCallback?.(0))

		expect(snapshots).toHaveLength(rendersBeforeBatch + 1)
		const current = snapshots.at(-1)!
		expect(current.liveTasksById).not.toBe(previous.liveTasksById)
		expect(Object.keys(current.liveTasksById ?? {})).toHaveLength(32)
		for (const taskId of Object.keys(liveTasksById)) {
			expect(current.liveTasksById?.[taskId]).toEqual(makeLiveTask(taskId, taskId === "background-0" ? 3 : 2))
			expect(previous.liveTasksById?.[taskId]).toEqual(makeLiveTask(taskId, 1))
		}
		expect(current.alphaMessages).toBe(previous.alphaMessages)
		expect(current.alphaMessagesSeq).toBe(previous.alphaMessagesSeq)
	})

	it("ignores stale incremental messages and replaces duplicate creations idempotently", () => {
		const baseMessage: AlphaMessage = { ts: 1, type: "say", say: "text", text: "current" }

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
						state: { currentTaskId: "task-1", alphaMessages: [baseMessage], alphaMessagesSeq: 5 },
					},
				}),
			)
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "messageCreated",
						taskId: "task-1",
						alphaMessage: { ...baseMessage, text: "stale" },
						alphaMessagesSeq: 4,
					},
				}),
			)
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "messageCreated",
						taskId: "task-1",
						alphaMessage: { ...baseMessage, text: "replacement" },
						alphaMessagesSeq: 6,
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
			alphaMessages: [],
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
			apiConfiguration: { apiProvider: "openai" } as ProviderSettings,
			telemetrySetting: "unset",
			showAlphaIgnoredFiles: true,
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
			alphaMessages: [],
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
			showAlphaIgnoredFiles: true,
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

		const makeMessage = (ts: number, text: string): AlphaMessage =>
			({ ts, type: "say", say: "text", text }) as AlphaMessage

		it("reuses a cached task transcript only while its revision is current", () => {
			const transcriptCache = new Map()
			const parentMessages = [makeMessage(1, "parent")]
			const childMessages = [makeMessage(2, "child")]
			const parentState: ExtensionState = {
				...baseState,
				currentTaskId: "parent",
				currentView: { type: "task", taskId: "parent" },
				alphaMessages: parentMessages,
				alphaMessagesSeq: 1,
				taskStateSeq: 1,
				liveTasksById: { parent: { id: "parent", transcriptRevision: 10 } as any },
			}
			const childIdentity = mergeExtensionState(
				parentState,
				{
					currentTaskId: "child",
					currentView: { type: "task", taskId: "child" },
					alphaMessages: [],
					alphaMessagesSeq: 2,
					taskStateSeq: 2,
					liveTasksById: {
						parent: { id: "parent", transcriptRevision: 10 },
						child: { id: "child", transcriptRevision: 20 },
					} as any,
				},
				transcriptCache,
			)
			const childState = mergeExtensionState(
				childIdentity,
				{
					currentTaskId: "child",
					currentView: { type: "task", taskId: "child" },
					alphaMessages: childMessages,
					alphaMessagesSeq: 3,
					taskStateSeq: 2,
				},
				transcriptCache,
			)

			const parentIdentity = mergeExtensionState(
				childState,
				{
					currentTaskId: "parent",
					currentView: { type: "task", taskId: "parent" },
					alphaMessages: [],
					alphaMessagesSeq: 4,
					taskStateSeq: 3,
					liveTasksById: {
						parent: { id: "parent", transcriptRevision: 10 },
						child: { id: "child", transcriptRevision: 20 },
					} as any,
				},
				transcriptCache,
			)
			expect(parentIdentity.alphaMessages).toBe(parentMessages)

			const staleParentIdentity = mergeExtensionState(
				childState,
				{
					currentTaskId: "parent",
					currentView: { type: "task", taskId: "parent" },
					alphaMessages: [],
					alphaMessagesSeq: 5,
					taskStateSeq: 4,
					liveTasksById: {
						parent: { id: "parent", transcriptRevision: 11 },
						child: { id: "child", transcriptRevision: 20 },
					} as any,
				},
				transcriptCache,
			)
			expect(staleParentIdentity.alphaMessages).toEqual([])
		})

		it("rejects stale alphaMessages when seq is not newer", () => {
			const newerMessages = [makeMessage(1, "hello"), makeMessage(2, "world")]
			const staleMessages = [makeMessage(1, "hello")]

			const prevState: ExtensionState = {
				...baseState,
				alphaMessages: newerMessages,
				alphaMessagesSeq: 5,
			}

			const result = mergeExtensionState(prevState, {
				alphaMessages: staleMessages,
				alphaMessagesSeq: 3, // stale seq
			})

			// Should keep the newer messages
			expect(result.alphaMessages).toBe(newerMessages)
			expect(result.alphaMessagesSeq).toBe(5)
		})

		it("does not reopen a completed task when its stale view snapshot arrives after a new-task draft", () => {
			const draftMessages: AlphaMessage[] = []
			const prevState: ExtensionState = {
				...baseState,
				alphaMessages: draftMessages,
				alphaMessagesSeq: 5,
				currentTaskId: undefined,
				currentView: { type: "newTaskDraft" },
				currentTaskItem: undefined,
			}

			const result = mergeExtensionState(prevState, {
				alphaMessages: [makeMessage(1, "completed task")],
				alphaMessagesSeq: 4,
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
			expect(result.alphaMessages).toBe(draftMessages)
			expect(result.alphaMessagesSeq).toBe(5)
		})

		it.each([{ taskStateSeq: 4 }, { taskStateSeq: 5 }, { messageQueueSeq: 6 }])(
			"does not let rejected task-domain nulls clear the selected chat (%j)",
			(sequence) => {
				const previous: ExtensionState = {
					...baseState,
					taskStateSeq: 5,
					currentTaskId: "selected-task",
					activeTaskId: "selected-task",
					currentView: { type: "task", taskId: "selected-task" },
					currentTaskItem: {
						id: "selected-task",
						number: 1,
						ts: 1,
						task: "selected",
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
					},
				}
				// Explicit nulls are accepted by the transport to clear optional identity fields.
				const delivered = JSON.parse(
					JSON.stringify({
						...sequence,
						currentTaskId: null,
						currentTaskItem: null,
						activeTaskId: null,
						currentView: { type: "newTaskDraft" },
					}),
				) as Partial<ExtensionState>
				const result = mergeExtensionState(previous, delivered)
				expect(result.currentTaskId).toBe(previous.currentTaskId)
				expect(result.currentTaskItem).toBe(previous.currentTaskItem)
				expect(result.activeTaskId).toBe(previous.activeTaskId)
				expect(result.currentView).toBe(previous.currentView)
			},
		)

		it.each([{ taskStateSeq: 4 }, { taskStateSeq: 5 }, { messageQueueSeq: 6 }])(
			"keeps selected task controls when a snapshot loses task ownership (%j)",
			(sequence) => {
				const previous: ExtensionState = {
					...baseState,
					taskStateSeq: 5,
					currentTaskId: "selected-task",
					currentView: { type: "task", taskId: "selected-task" },
					mode: "architect",
					currentApiConfigName: "selected-profile",
					apiConfiguration: { apiProvider: "openai", apiModelId: "selected-model" },
					currentTaskApprovalMode: "ask",
				}
				const result = mergeExtensionState(previous, {
					...sequence,
					currentTaskId: "old-task",
					currentView: { type: "task", taskId: "old-task" },
					mode: "code",
					currentApiConfigName: "old-profile",
					apiConfiguration: { apiProvider: "anthropic", apiModelId: "old-model" },
					currentTaskApprovalMode: "auto",
				})

				expect(result.currentTaskId).toBe(previous.currentTaskId)
				expect(result.mode).toBe(previous.mode)
				expect(result.currentApiConfigName).toBe(previous.currentApiConfigName)
				expect(result.apiConfiguration).toBe(previous.apiConfiguration)
				expect(result.currentTaskApprovalMode).toBe(previous.currentTaskApprovalMode)
			},
		)

		it("keeps a newer mode/profile on the same task while accepting unsequenced global configuration", () => {
			const previous: ExtensionState = {
				...baseState,
				taskStateSeq: 5,
				currentTaskId: "selected-task",
				mode: "architect",
				currentApiConfigName: "selected-profile",
				apiConfiguration: { apiProvider: "openai", apiModelId: "selected-model" },
			}
			const stale = mergeExtensionState(previous, {
				taskStateSeq: 4,
				currentTaskId: "selected-task",
				mode: "code",
				currentApiConfigName: "old-profile",
				apiConfiguration: { apiProvider: "anthropic", apiModelId: "old-model" },
			})
			expect(stale.mode).toBe(previous.mode)
			expect(stale.currentApiConfigName).toBe(previous.currentApiConfigName)
			expect(stale.apiConfiguration).toBe(previous.apiConfiguration)

			const updated = mergeExtensionState(stale, {
				mode: "code",
				currentApiConfigName: "global-profile",
				apiConfiguration: { apiProvider: "vertex", apiModelId: "global-model" },
			})
			expect(updated.currentTaskId).toBe(previous.currentTaskId)
			expect(updated.mode).toBe("code")
			expect(updated.currentApiConfigName).toBe("global-profile")
			expect(updated.apiConfiguration).toEqual({ apiProvider: "vertex", apiModelId: "global-model" })
		})

		it("keeps reasoning scoped to the accepted task sequence and clears it when an older host switches tasks", () => {
			const previous: ExtensionState = {
				...baseState,
				currentTaskId: "b",
				taskStateSeq: 5,
				taskReasoning: {
					taskId: "b",
					requested: { kind: "effort", effort: "high" },
					effective: { kind: "effort", effort: "high" },
					capabilities: { kind: "effort", efforts: ["low", "high"], canDisable: true },
				},
			}
			const stale = mergeExtensionState(previous, {
				taskStateSeq: 4,
				currentTaskId: "a",
				taskReasoning: {
					taskId: "a",
					requested: { kind: "off" },
					effective: { kind: "off" },
					capabilities: { kind: "unavailable", canDisable: false },
				},
			})
			expect(stale.taskReasoning).toEqual(previous.taskReasoning)
			const switched = mergeExtensionState(previous, { taskStateSeq: 6, currentTaskId: "a" })
			expect(switched.taskReasoning).toBeUndefined()
		})

		it("clears a leftover task identity after a new-chat snapshot drops undefined currentTaskId", () => {
			const previous: ExtensionState = {
				...baseState,
				currentTaskId: "running-task",
				currentTaskItem: {
					id: "running-task",
					number: 1,
					ts: 1,
					task: "running",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
				currentView: { type: "task", taskId: "running-task" },
				taskStateSeq: 5,
				taskReasoning: {
					taskId: "running-task",
					requested: { kind: "effort", effort: "high" },
					effective: { kind: "effort", effort: "high" },
					capabilities: { kind: "effort", efforts: ["low", "high"], canDisable: true },
				},
			}
			const posted = {
				taskStateSeq: 6,
				currentView: { type: "newTaskDraft" as const },
				currentTaskId: undefined,
				currentTaskItem: undefined,
				alphaMessages: [],
				taskReasoning: {
					requested: { kind: "effort" as const, effort: "medium" as const },
					effective: { kind: "effort" as const, effort: "medium" as const },
					capabilities: { kind: "effort" as const, efforts: ["low", "medium", "high"], canDisable: true },
				},
			}
			const delivered = JSON.parse(JSON.stringify(posted)) as Partial<ExtensionState>
			expect("currentTaskId" in delivered).toBe(false)

			const result = mergeExtensionState(previous, delivered)
			expect(result.currentTaskId).toBeUndefined()
			expect(result.currentTaskItem).toBeUndefined()
			expect(result.currentView).toEqual({ type: "newTaskDraft" })
			expect(result.taskReasoning).toEqual(posted.taskReasoning)
		})

		it("clears leftover reasoning when a new-chat snapshot omits it after dropping currentTaskId", () => {
			const previous: ExtensionState = {
				...baseState,
				currentTaskId: "running-task",
				currentView: { type: "task", taskId: "running-task" },
				taskStateSeq: 5,
				taskReasoning: {
					taskId: "running-task",
					requested: { kind: "effort", effort: "high" },
					effective: { kind: "effort", effort: "high" },
					capabilities: { kind: "effort", efforts: ["low", "high"], canDisable: true },
				},
			}
			const delivered = JSON.parse(
				JSON.stringify({
					taskStateSeq: 6,
					currentView: { type: "newTaskDraft" as const },
					currentTaskId: undefined,
				}),
			) as Partial<ExtensionState>

			const result = mergeExtensionState(previous, delivered)
			expect(result.currentTaskId).toBeUndefined()
			expect(result.taskReasoning).toBeUndefined()
		})

		it.each([undefined, null])(
			"retains verified draft reasoning through a compact background lifecycle update (task id: %j)",
			(taskId) => {
				const previous: ExtensionState = {
					...baseState,
					currentTaskId: undefined,
					currentView: { type: "newTaskDraft" },
					currentApiConfigName: "copilot-profile",
					apiConfiguration: {
						apiProvider: "vscode-lm",
						vsCodeLmModelSelector: { vendor: "copilot", id: "gpt-5.6-sol" },
					},
					taskStateSeq: 5,
					taskReasoning: {
						requested: { kind: "effort", effort: "high" },
						effective: { kind: "effort", effort: "high" },
						capabilities: { kind: "effort", efforts: ["low", "high"], canDisable: true },
					},
				}
				// postLocalTaskSessionStateToWebview publishes task membership without a reasoning or config refresh.
				const delivered = JSON.parse(
					JSON.stringify({
						currentView: { type: "newTaskDraft" },
						currentTaskId: taskId,
						activeTaskId: "background-task",
						liveTaskIds: ["background-task"],
						taskStateSeq: 6,
					}),
				) as Partial<ExtensionState>

				const result = mergeExtensionState(previous, delivered)

				expect(result.taskReasoning).toBe(previous.taskReasoning)
				expect(result.currentTaskId).toBeUndefined()
				expect(result.activeTaskId).toBe("background-task")
				expect(result.taskStateSeq).toBe(6)
			},
		)

		it.each([
			{ currentTaskId: "another-task" },
			{ currentApiConfigName: "new-profile" },
			{ apiConfiguration: { apiProvider: "openai" as const, openAiModelId: "gpt-5.6-sol" } },
			{
				apiConfiguration: {
					apiProvider: "vscode-lm" as const,
					vsCodeLmModelSelector: { vendor: "copilot", id: "new-model" },
				},
			},
		])("clears draft reasoning when its task, profile, or provider/model scope changes: %j", (scopeChange) => {
			const previous: ExtensionState = {
				...baseState,
				currentTaskId: undefined,
				currentView: { type: "newTaskDraft" },
				taskStateSeq: 5,
				taskReasoning: {
					requested: { kind: "effort", effort: "high" },
					effective: { kind: "effort", effort: "high" },
					capabilities: { kind: "effort", efforts: ["low", "high"], canDisable: true },
				},
			}
			const result = mergeExtensionState(previous, {
				currentView: { type: "newTaskDraft" },
				taskStateSeq: 6,
				...scopeChange,
			})
			expect(result.taskReasoning).toBeUndefined()
		})

		it.each([
			undefined,
			{
				requested: { kind: "default" as const },
				effective: { kind: "off" as const },
				capabilities: { kind: "unavailable" as const, canDisable: false },
			},
		])("honors an explicit replacement for draft reasoning: %j", (replacement) => {
			const previous: ExtensionState = {
				...baseState,
				currentTaskId: undefined,
				currentView: { type: "newTaskDraft" },
				taskStateSeq: 5,
				taskReasoning: {
					requested: { kind: "effort", effort: "high" },
					effective: { kind: "effort", effort: "high" },
					capabilities: { kind: "effort", efforts: ["low", "high"], canDisable: true },
				},
			}
			const result = mergeExtensionState(previous, {
				currentView: { type: "newTaskDraft" },
				taskStateSeq: 6,
				taskReasoning: replacement,
			})
			expect(result.taskReasoning).toBe(replacement)
		})

		it("rejects alphaMessages when seq equals current (not strictly greater)", () => {
			const currentMessages = [makeMessage(1, "hello"), makeMessage(2, "world")]
			const sameSeqMessages = [makeMessage(1, "hello")]

			const prevState: ExtensionState = {
				...baseState,
				alphaMessages: currentMessages,
				alphaMessagesSeq: 5,
			}

			const result = mergeExtensionState(prevState, {
				alphaMessages: sameSeqMessages,
				alphaMessagesSeq: 5, // same seq, not strictly greater
			})

			expect(result.alphaMessages).toBe(currentMessages)
			expect(result.alphaMessagesSeq).toBe(5)
		})

		it("drops a transcript from an older navigation even when its message sequence is newer", () => {
			const currentMessages = [makeMessage(2, "new task")]
			const previous: ExtensionState = {
				...baseState,
				currentTaskId: "new-task",
				taskStateSeq: 6,
				alphaMessages: currentMessages,
				alphaMessagesSeq: 8,
			}

			const result = mergeExtensionState(previous, {
				currentTaskId: "old-task",
				taskStateSeq: 5,
				alphaMessages: [makeMessage(1, "old transcript")],
				alphaMessagesSeq: 9,
			})

			expect(result.currentTaskId).toBe("new-task")
			expect(result.alphaMessages).toBe(currentMessages)
			expect(result.alphaMessagesSeq).toBe(8)
		})
		it("rejects another chat's consumed queue projection without a navigation sequence", () => {
			const messages = [makeMessage(2, "current chat")]
			const queue = [{ id: "current-input", text: "still waiting", timestamp: 2 }]
			const previous: ExtensionState = {
				...baseState,
				currentTaskId: "current-chat",
				taskStateSeq: 6,
				alphaMessages: messages,
				alphaMessagesSeq: 8,
				messageQueue: queue,
				messageQueueSeq: 8,
			}
			const result = mergeExtensionState(previous, {
				currentTaskId: "background-chat",
				messageQueue: [],
				messageQueueSeq: 9,
				alphaMessages: [makeMessage(1, "consumed background input")],
				alphaMessagesSeq: 9,
			})
			expect(result.currentTaskId).toBe("current-chat")
			expect(result.messageQueue).toBe(queue)
			expect(result.alphaMessages).toBe(messages)
			expect(result.alphaMessagesSeq).toBe(8)
		})
		it("accepts the visible chat's consumed queue projection without a navigation sequence", () => {
			const previous: ExtensionState = {
				...baseState,
				currentTaskId: "current-chat",
				taskStateSeq: 6,
				alphaMessages: [],
				alphaMessagesSeq: 8,
				messageQueue: [{ id: "input", text: "waiting", timestamp: 2 }],
				messageQueueSeq: 8,
			}
			const messages = [makeMessage(2, "consumed current input")]
			const result = mergeExtensionState(previous, {
				currentTaskId: "current-chat",
				messageQueue: [],
				messageQueueSeq: 9,
				alphaMessages: messages,
				alphaMessagesSeq: 9,
			})
			expect(result.currentTaskId).toBe("current-chat")
			expect(result.messageQueue).toEqual([])
			expect(result.alphaMessages).toBe(messages)
			expect(result.alphaMessagesSeq).toBe(9)
		})

		it("accepts the transcript that belongs to the navigation already on screen", () => {
			const transcript = [makeMessage(1, "loaded")]
			const previous: ExtensionState = {
				...baseState,
				currentTaskId: "task-1",
				taskStateSeq: 6,
				alphaMessages: [],
				alphaMessagesSeq: 8,
			}

			const result = mergeExtensionState(previous, {
				currentTaskId: "task-1",
				currentView: { type: "task", taskId: "task-1" },
				taskStateSeq: 6,
				alphaMessages: transcript,
				alphaMessagesSeq: 9,
			})

			expect(result.currentTaskId).toBe("task-1")
			expect(result.alphaMessages).toBe(transcript)
			expect(result.alphaMessagesSeq).toBe(9)
		})

		it("keeps the visible transcript when a background session patch arrives", () => {
			const messages = [makeMessage(1, "parent")]
			const previous: ExtensionState = {
				...baseState,
				currentTaskId: "parent",
				taskStateSeq: 4,
				alphaMessages: messages,
				alphaMessagesSeq: 4,
			}

			const result = mergeExtensionState(previous, {
				currentTaskId: "parent",
				taskStateSeq: 5,
				liveTaskIds: ["parent", "child"],
			})

			expect(result.currentTaskId).toBe("parent")
			expect(result.alphaMessages).toBe(messages)
			expect(result.taskStateSeq).toBe(5)
		})

		it("accepts alphaMessages when seq is strictly greater", () => {
			const oldMessages = [makeMessage(1, "hello")]
			const newMessages = [makeMessage(1, "hello"), makeMessage(2, "world")]

			const prevState: ExtensionState = {
				...baseState,
				alphaMessages: oldMessages,
				alphaMessagesSeq: 3,
			}

			const result = mergeExtensionState(prevState, {
				alphaMessages: newMessages,
				alphaMessagesSeq: 4, // newer seq
			})

			expect(result.alphaMessages).toBe(newMessages)
			expect(result.alphaMessagesSeq).toBe(4)
		})

		it("preserves alphaMessages when newState does not include them (cloud event path)", () => {
			const existingMessages = [makeMessage(1, "hello"), makeMessage(2, "world")]

			const prevState: ExtensionState = {
				...baseState,
				alphaMessages: existingMessages,
				alphaMessagesSeq: 5,
			}

			// Simulate a cloud event push that omits alphaMessages and alphaMessagesSeq
			const result = mergeExtensionState(prevState, {})

			expect(result.alphaMessages).toBe(existingMessages)
			expect(result.alphaMessagesSeq).toBe(5)
		})

		it("applies alphaMessages normally when neither state has seq (backward compat)", () => {
			const oldMessages = [makeMessage(1, "hello")]
			const newMessages = [makeMessage(1, "hello"), makeMessage(2, "world")]

			const prevState: ExtensionState = {
				...baseState,
				alphaMessages: oldMessages,
			}

			const result = mergeExtensionState(prevState, {
				alphaMessages: newMessages,
			})

			expect(result.alphaMessages).toBe(newMessages)
		})

		it("applies alphaMessages when prevState has no seq but newState does (first push)", () => {
			const prevState: ExtensionState = {
				...baseState,
				alphaMessages: [],
			}

			const newMessages = [makeMessage(1, "hello")]
			const result = mergeExtensionState(prevState, {
				alphaMessages: newMessages,
				alphaMessagesSeq: 1,
			})

			expect(result.alphaMessages).toBe(newMessages)
			expect(result.alphaMessagesSeq).toBe(1)
		})

		it("applies lifecycle and queue updates by independent sequence domains", () => {
			const currentMessages = [makeMessage(1, "current transcript")]
			const prevState: ExtensionState = {
				...baseState,
				currentTaskId: "task-1",
				currentView: { type: "task", taskId: "task-1" },
				alphaMessages: currentMessages,
				alphaMessagesSeq: 10,
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
				alphaMessages: [makeMessage(1, "stale transcript")],
				alphaMessagesSeq: 9,
				messageQueue: [{ id: "stale", text: "stale queue", images: [], timestamp: 3 }],
				messageQueueSeq: 7,
			})

			expect(afterLifecycle.alphaMessages).toBe(currentMessages)
			expect(afterLifecycle.messageQueue?.map((message) => message.text)).toEqual(["new queue"])
			expect(afterLifecycle.liveTasksById?.["task-1"]).toMatchObject({
				lifecycle: "waiting",
				isWaitingForInput: true,
				waitingReason: "completion",
			})
			expect(afterLifecycle.taskStateSeq).toBe(5)
			expect(afterLifecycle.messageQueueSeq).toBe(8)
		})

		it.each([
			[TaskLifecycleState.Completed, TaskLifecycleState.Running],
			[TaskLifecycleState.Running, TaskLifecycleState.Completed],
		])("keeps newer transcript metadata in %s across an older %s state projection", (lifecycle, staleLifecycle) => {
			const metadata = {
				id: "task-1",
				transcriptRevision: 12,
				status: lifecycle === TaskLifecycleState.Completed ? TaskStatus.Idle : TaskStatus.Running,
				lifecycle,
				isActive: true,
				isStreaming: false,
				isWaitingForInput: false,
				lastUpdatedAt: 100,
				queueCount: 0,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			}
			const previous: ExtensionState = {
				...baseState,
				currentTaskId: "task-1",
				taskStateSeq: 1,
				liveTasksById: { "task-1": metadata },
			}
			const projected = mergeExtensionState(previous, {
				taskStateSeq: 2,
				liveTasksById: { "task-1": { ...metadata, transcriptRevision: 11, lifecycle: staleLifecycle } },
			})
			expect(projected.liveTasksById?.["task-1"]).toEqual(metadata)

			const refreshed = mergeExtensionState(projected, {
				taskStateSeq: 3,
				liveTasksById: { "task-1": { ...metadata, lifecycle: staleLifecycle } },
			})
			expect(refreshed.liveTasksById?.["task-1"]?.lifecycle).toBe(staleLifecycle)
			const removed = mergeExtensionState(refreshed, { taskStateSeq: 4, liveTasksById: {} })
			expect(removed.liveTasksById).toEqual({})
		})

		it("preserves host completion review across executing snapshots and releases it on host follow-up", () => {
			const taskId = "lifecycle-task"
			const snapshot = makeLifecycleSnapshot({ phase: "executing" })
			const waiting: ExtensionState = {
				...baseState,
				currentTaskId: taskId,
				liveTaskIds: [taskId],
				agentLifecycleSnapshots: { [taskId]: snapshot },
				liveTasksById: {
					[taskId]: {
						id: taskId,
						lifecycle: TaskLifecycleState.Waiting,
						status: TaskStatus.Idle,
						isActive: true,
						isStreaming: false,
						isTurnActive: true,
						canInterrupt: false,
						isWaitingForInput: true,
						waitingReason: "completion",
						lastUpdatedAt: 100,
						queueCount: 0,
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
					},
				},
			}
			const reviewed = mergeExtensionState(waiting, {})
			expect(reviewed.liveTasksById?.[taskId]).toMatchObject({
				lifecycle: TaskLifecycleState.Waiting,
				status: TaskStatus.Idle,
				isWaitingForInput: true,
				waitingReason: "completion",
				canInterrupt: false,
			})
			const replayed = mergeExtensionState(reviewed, { agentLifecycleSnapshots: { [taskId]: snapshot } })
			expect(replayed.liveTasksById?.[taskId]).toEqual(reviewed.liveTasksById?.[taskId])
			const continued = mergeExtensionState(replayed, {
				liveTasksById: {
					[taskId]: {
						...waiting.liveTasksById![taskId],
						lifecycle: TaskLifecycleState.Running,
						status: TaskStatus.Running,
						isWaitingForInput: false,
						waitingReason: undefined,
						isStreaming: true,
						canInterrupt: true,
					},
				},
			})
			expect(continued.liveTasksById?.[taskId]).toMatchObject({
				lifecycle: TaskLifecycleState.Running,
				isWaitingForInput: false,
				isStreaming: true,
				canInterrupt: true,
			})
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
				alphaMessagesSeq: 20,
				messageQueue: [],
			}

			const result = mergeExtensionState(prevState, {
				currentTaskId: "task-1",
				messageQueue: [{ id: "new", text: "first dedicated queue", images: [], timestamp: 1 }],
				messageQueueSeq: 1,
			})

			expect(result.messageQueue?.map((message) => message.text)).toEqual(["first dedicated queue"])
			expect(result.messageQueueSeq).toBe(1)
			expect(result.alphaMessagesSeq).toBe(20)
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
		expect(screen.getByTestId("lifecycle-task-state")).toHaveTextContent("running")
		expect(screen.getByTestId("lifecycle-task-status")).toHaveTextContent("running")
		expect(screen.getByTestId("lifecycle-live-task-ids")).toHaveTextContent("lifecycle-task")

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
		expect(screen.getByTestId("lifecycle-task-state")).toHaveTextContent("running")
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
				alphaMessages: [{ ts: 1, type: "say", say: "text", text: "legacy work" } as AlphaMessage],
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
		expect(screen.getByTestId("lifecycle-task-state")).toHaveTextContent("running")
		expect(screen.getByTestId("lifecycle-live-task-ids")).toHaveTextContent("lifecycle-task")
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

describe("shell state isolation", () => {
	it("does not re-render shell consumers when only the transcript updates", () => {
		let shellRenderCount = 0
		const ShellProbe = () => {
			shellRenderCount += 1
			useShellState()
			return <div data-testid="shell-renders">{shellRenderCount}</div>
		}
		const TranscriptProbe = () => {
			const { alphaMessages } = useExtensionState()
			return <div data-testid="transcript-count">{alphaMessages.length}</div>
		}

		render(
			<ExtensionStateContextProvider>
				<ShellProbe />
				<TranscriptProbe />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "state",
						state: {
							mode: "code",
							currentTaskId: "task-1",
							alphaMessages: [{ ts: 1, type: "say", say: "text", text: "hello" }],
							alphaMessagesSeq: 1,
						},
					},
				}),
			)
		})

		const rendersAfterHydrate = Number(screen.getByTestId("shell-renders").textContent)
		expect(screen.getByTestId("transcript-count")).toHaveTextContent("1")

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "state",
						state: {
							alphaMessages: [
								{ ts: 1, type: "say", say: "text", text: "hello" },
								{ ts: 2, type: "say", say: "text", text: "stream" },
							],
							alphaMessagesSeq: 2,
						},
					},
				}),
			)
		})

		expect(screen.getByTestId("transcript-count")).toHaveTextContent("2")
		expect(screen.getByTestId("shell-renders")).toHaveTextContent(String(rendersAfterHydrate))
	})
})
