import { act, render, screen } from "@/utils/test-utils"
import { DEFAULT_CHECKPOINT_TIMEOUT_SECONDS, type ExtensionState } from "@alpha-code/types"

import { ExtensionStateContextProvider, useExtensionState } from "../ExtensionStateContext"
import { retainUnchangedExtensionState } from "../ExtensionStateContextStore"

const createState = (): ExtensionState => ({
	version: "",
	apiConfiguration: {},
	alphaMessages: [],
	taskHistory: [],
	shouldShowAnnouncement: false,
	enableCheckpoints: true,
	checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	writeDelayMs: 1000,
	maxConcurrentTasks: 3,
	mode: "code",
	experiments: {},
	customModes: [],
	maxOpenTabsContext: 20,
	maxWorkspaceFiles: 100,
	mcpEnabled: false,
	telemetrySetting: "unset",
	showAlphaIgnoredFiles: true,
	enableSubfolderRules: false,
	renderContext: "sidebar",
	autoCondenseContext: true,
	autoCondenseContextPercent: 100,
	autoSteer: false,
	alphaMessagesSeq: 0,
	profileThresholds: {},
	hasOpenedModeSelector: false,
	maxImageFileSize: 5,
	maxTotalImageSize: 20,
	maxReadFileLine: -1,
})

describe("retainUnchangedExtensionState", () => {
	it("retains the previous state when the own fields have identical values", () => {
		const previous = createState()
		expect(retainUnchangedExtensionState(previous, previous)).toBe(previous)
		expect(retainUnchangedExtensionState(previous, { ...previous })).toBe(previous)
	})

	it("publishes changed scalar values and fresh nested references", () => {
		const previous = createState()
		const changedPreference = { ...previous, autoSteer: true }
		const changedTranscript = { ...previous, alphaMessages: [...previous.alphaMessages] }
		const changedSequence = { ...previous, alphaMessagesSeq: 1 }

		expect(retainUnchangedExtensionState(previous, changedPreference)).toBe(changedPreference)
		expect(retainUnchangedExtensionState(previous, changedTranscript)).toBe(changedTranscript)
		expect(retainUnchangedExtensionState(previous, changedSequence)).toBe(changedSequence)
	})

	it("preserves additions and removals of explicitly undefined keys", () => {
		const previous = createState()
		const withUndefined = { ...previous, currentTaskId: undefined }

		expect(retainUnchangedExtensionState(previous, withUndefined)).toBe(withUndefined)
		expect(retainUnchangedExtensionState(withUndefined, previous)).toBe(previous)
	})

	it("does not confuse different own keys with undefined values", () => {
		const state = createState()
		const previous = { ...state, currentTaskId: undefined }
		const next = { ...state, activeTaskId: undefined }

		expect(retainUnchangedExtensionState(previous, next)).toBe(next)
	})

	it("preserves null values and distinguishes them from undefined or absent wire fields", () => {
		const state = createState()
		const previous = { ...state, futureWireField: null }
		const cleared = { ...state, futureWireField: undefined }

		expect(retainUnchangedExtensionState(previous, { ...previous })).toBe(previous)
		expect(retainUnchangedExtensionState(previous, cleared)).toBe(cleared)
		expect(retainUnchangedExtensionState(cleared, previous)).toBe(previous)
		expect(retainUnchangedExtensionState(previous, state)).toBe(state)
	})

	it("uses React snapshot equality for NaN and signed zero", () => {
		const previous = { ...createState(), writeDelayMs: Number.NaN }
		expect(retainUnchangedExtensionState(previous, { ...previous })).toBe(previous)

		const positiveZero = { ...previous, writeDelayMs: 0 }
		const negativeZero = { ...previous, writeDelayMs: -0 }
		expect(retainUnchangedExtensionState(positiveZero, negativeZero)).toBe(negativeZero)
	})
})

describe("duplicate extension state publications", () => {
	it("avoids consumer renders for 100 unchanged peer preference patches and still applies a changed value", () => {
		const renderProbe = vi.fn()
		const Probe = () => {
			const { autoSteer } = useExtensionState()
			renderProbe()
			return <div data-testid="auto-steer">{String(autoSteer)}</div>
		}
		render(
			<ExtensionStateContextProvider>
				<Probe />
			</ExtensionStateContextProvider>,
		)
		const publish = (autoSteer: boolean) =>
			act(() => {
				window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state: { autoSteer } } }))
			})

		// The first host snapshot hydrates and normalizes optional projection fields.
		publish(false)
		const rendersAfterHydration = renderProbe.mock.calls.length
		for (let index = 0; index < 100; index++) publish(false)

		expect(renderProbe).toHaveBeenCalledTimes(rendersAfterHydration)
		expect(screen.getByTestId("auto-steer")).toHaveTextContent("false")

		publish(true)
		expect(renderProbe).toHaveBeenCalledTimes(rendersAfterHydration + 1)
		expect(screen.getByTestId("auto-steer")).toHaveTextContent("true")
	})
})
