import * as path from "path"
import * as fs from "fs/promises"
import Mocha from "mocha"
import { glob } from "glob"
import * as vscode from "vscode"

import type { RooCodeAPI } from "@alpha-code/types"

import { waitFor } from "./utils"
import { createSerializedJsonWriter, summarizeMochaFailure, type MochaFailureDiagnostic } from "./preflightEvidence"
import { assertRunnerAncestry } from "../hostOwnership"
import { discoverLiveCopilotModels, type LiveCopilotPreflightErrorCode } from "../liveModelSelection"
import {
	getLiveCopilotOptionsFromEnvironment,
	runLiveCopilotPreflight,
	runPersistentLiveSetup,
	type LiveSetupAction,
	type LiveSetupState,
} from "./liveCopilot"
import { TestRunError, testSuiteOutcome, type TestExecutionCounts, type TestRunFailureCode } from "../runFailure"

function providerFailure(code: LiveCopilotPreflightErrorCode | undefined): TestRunFailureCode {
	switch (code) {
		case "model-unavailable":
		case "model-selection-ambiguous":
		case "authentication-required":
		case "invalid-options":
		case "effort-unavailable":
			return code
		case "authentication-unknown":
			return "authentication-unknown"
		case "effort-unknown":
			return "effort-unavailable"
		case "artifact-write-failed":
			return "evidence-failed"
		default:
			return "provider-unavailable"
	}
}

type SetupCheck = { ready: boolean; failure?: TestRunFailureCode; stage: string }

async function waitForSetup(
	check: (signal: AbortSignal) => Promise<SetupCheck>,
	context?: Pick<vscode.ExtensionContext, "subscriptions">,
) {
	const cancellation = new AbortController()
	const lifetime = { dispose: () => cancellation.abort() }
	context?.subscriptions.push(lifetime)
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
	const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { action: LiveSetupAction }>()
	picker.title = "Alpha Copilot test-profile setup"
	picker.placeholder = "Dismiss to keep the test window open; Finish closes it only after a successful check."
	let dispatch: (action: LiveSetupAction) => void = () => {}
	const render = (state: LiveSetupState<SetupCheck>) => {
		status.text = state.phase === "checking" ? "$(sync~spin) Copilot test setup" : "$(account) Copilot test setup"
		status.tooltip =
			state.phase === "ready"
				? "Setup check passed. Choose Finish when you are done."
				: `Sign in through Accounts, then choose Continue / Retry. ${state.check?.failure ?? ""}`
		picker.items = [
			{
				label: "Continue / Retry",
				action: "continue",
				description: "Check this profile once; no automatic retries",
			},
			{
				label: "Finish",
				action: "finish",
				description:
					state.phase === "ready" ? "Save success and close the test window" : "Requires a successful check",
			},
			{ label: "Cancel", action: "cancel", description: "Stop setup without a passing result" },
		]
		picker.busy = state.phase === "checking"
	}
	const command = vscode.commands.registerCommand("alpha.e2e.liveCopilotSetup", () => picker.show())
	const accept = picker.onDidAccept(() => {
		const selected = picker.selectedItems[0]
		picker.hide()
		dispatch(selected?.action)
	})
	status.command = "alpha.e2e.liveCopilotSetup"
	status.show()
	try {
		return await runPersistentLiveSetup(check, {
			signal: cancellation.signal,
			timeoutMs: process.env.ALPHA_E2E_SETUP_TIMEOUT_MS
				? Number(process.env.ALPHA_E2E_SETUP_TIMEOUT_MS)
				: undefined,
			render,
			onAction: (handler) => {
				dispatch = handler
				void vscode.window
					.showInformationMessage(
						"Alpha test profile: sign in to GitHub Copilot through Accounts. This window stays open until Finish or Cancel. Reopen controls using Copilot test setup in the status bar.",
						"Continue setup",
					)
					.then(
						(choice) => dispatch(choice ? "continue" : undefined),
						() => dispatch(undefined),
					)
				return { dispose: () => (dispatch = () => {}) }
			},
		})
	} finally {
		lifetime.dispose()
		const index = context?.subscriptions.indexOf(lifetime) ?? -1
		if (index >= 0) context?.subscriptions.splice(index, 1)
		accept.dispose()
		command.dispose()
		picker.dispose()
		status.dispose()
	}
}

export async function run() {
	const artifactsDir = process.env.ALPHA_E2E_ARTIFACTS_DIR
	const runId = process.env.ALPHA_E2E_RUN_ID
	const expectedVersion = process.env.ALPHA_E2E_EXPECTED_VSCODE_VERSION
	const hostMetadata: {
		schemaVersion: number
		runId?: string
		actualVSCodeVersion: string
		actualModelId?: string
		actualModelFamily?: string
		actualReasoningEffort?: string
		stage?: string
		testCounts?: TestExecutionCounts
		failureDiagnostics?: MochaFailureDiagnostic[]
	} = {
		schemaVersion: 1,
		runId,
		actualVSCodeVersion: vscode.version,
	}
	let ownershipGate: "verified" | undefined
	const writePreflight = artifactsDir
		? createSerializedJsonWriter(path.join(artifactsDir, "host-preflight.json"))
		: undefined
	const recordPreflight = async (status: "passed" | "failed" | "blocked", code?: string) => {
		if (writePreflight)
			await writePreflight({
				...hostMetadata,
				status,
				code,
				ownershipGate,
			})
	}
	if (expectedVersion && vscode.version !== expectedVersion) {
		await recordPreflight("blocked", "host-version-mismatch")
		throw new Error("The actual VS Code host does not match the requested version")
	}
	if (process.env.ALPHA_E2E_PROFILE_DIR) {
		try {
			await assertRunnerAncestry(Number(process.env.ALPHA_E2E_RUNNER_PID))
			ownershipGate = "verified"
		} catch {
			await recordPreflight("blocked", "host-not-owned")
			throw new Error("The persistent profile host is not owned by this test runner")
		}
	}
	if (artifactsDir)
		await fs.writeFile(
			path.join(artifactsDir, "host-identity.json"),
			JSON.stringify(
				{
					...hostMetadata,
					pid: process.pid,
					ppid: process.ppid,
					ownershipGate,
				},
				null,
				2,
			),
			{ flag: "wx", mode: 0o600 },
		)
	await recordPreflight("passed")
	const extensionId = process.env.ALPHA_E2E_EXTENSION_ID
	if (!extensionId) throw new Error("ALPHA_E2E_EXTENSION_ID was not provided by the E2E runner")
	const extension = vscode.extensions.getExtension<RooCodeAPI>(extensionId)

	if (!extension) {
		throw new Error(`Development extension ${extensionId} was not found`)
	}

	const api = extension.isActive ? extension.exports : await extension.activate()
	const providerMode = process.env.ALPHA_E2E_PROVIDER_MODE ?? "live"
	if (providerMode === "live") {
		const openRouterApiKey = process.env.OPENROUTER_API_KEY
		if (!openRouterApiKey) {
			throw new Error(
				"OPENROUTER_API_KEY is required for live E2E tests. Use --provider scripted for deterministic tests.",
			)
		}
		await api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey,
			openRouterModelId: "openai/gpt-4.1",
		})
	} else if (providerMode === "live-copilot") {
		try {
			if (
				process.env.ALPHA_E2E_REQUEST_LIMIT &&
				(!process.env.ALPHA_E2E_SCENARIO_ID || process.env.ALPHA_E2E_SETUP)
			) {
				throw new TestRunError(
					"request-budget-unsupported",
					"Request limits require a guarded workflow scenario",
				)
			}
			const setup = process.env.ALPHA_E2E_SETUP === "1"
			const options = getLiveCopilotOptionsFromEnvironment(process.env, artifactsDir)
			// The stable access API belongs to Alpha's ExtensionContext, not vscode.env.
			// This narrow test-only bridge mirrors the other API host-internal integration tests.
			const context = (
				api as unknown as {
					context?: Pick<vscode.ExtensionContext, "languageModelAccessInformation" | "subscriptions">
				}
			).context
			const check = async (signal?: AbortSignal): Promise<SetupCheck> => {
				if (!options) {
					if (!setup) throw new TestRunError("invalid-options", "An exact Copilot model ID is required")
					const discovery = await discoverLiveCopilotModels({ setup: true, artifactsDir }, { signal })
					if (discovery.artifact?.status === "failed")
						throw new TestRunError("evidence-failed", "Discovery evidence could not be recorded")
					const ready = discovery.status === "available" && discovery.modelCount > 0
					return { ready, failure: ready ? undefined : "model-unavailable", stage: "discovery-only" }
				}
				const preflight = await runLiveCopilotPreflight(api, options, {
					signal,
					canSendRequest: (model) => context?.languageModelAccessInformation?.canSendRequest(model),
				})
				if (preflight.error?.code === "artifact-write-failed")
					throw new TestRunError("evidence-failed", "Preflight evidence could not be recorded")
				hostMetadata.actualModelId = preflight.discovery.selectedModel?.id
				hostMetadata.actualModelFamily = preflight.discovery.selectedModel?.family
				hostMetadata.actualReasoningEffort = preflight.configuration.reasoningEffort
				return {
					ready: preflight.ready,
					failure: preflight.ready ? undefined : providerFailure(preflight.error?.code),
					stage: setup ? "consent-preflight-only" : "scenario-ready",
				}
			}
			if (setup) {
				hostMetadata.stage = "setup-waiting"
				await recordPreflight("blocked", "setup-incomplete")
				const result = await waitForSetup(async (signal) => {
					const checked = await check(signal)
					hostMetadata.stage = checked.ready ? "setup-ready" : "setup-waiting"
					await recordPreflight("blocked", checked.failure ?? "setup-incomplete")
					return checked
				}, context)
				if (result.status !== "finished") {
					hostMetadata.stage = result.status === "cancelled" ? "setup-cancelled" : "setup-timed-out"
					throw new TestRunError(
						result.status === "cancelled" ? "host-cancelled" : "setup-timeout",
						"Interactive setup did not finish",
					)
				}
				hostMetadata.stage = result.check.stage
				await recordPreflight("passed")
				return
			}
			const checked = await check()
			if (!checked.ready)
				throw new TestRunError(checked.failure ?? "provider-unavailable", "Live Copilot preflight is blocked")
			hostMetadata.stage = checked.stage
			process.env.ALPHA_E2E_ACTUAL_MODEL_ID = hostMetadata.actualModelId
			process.env.ALPHA_E2E_ACTUAL_MODEL_FAMILY = hostMetadata.actualModelFamily
			if (hostMetadata.actualReasoningEffort)
				process.env.ALPHA_E2E_ACTUAL_REASONING_EFFORT = hostMetadata.actualReasoningEffort
			else delete process.env.ALPHA_E2E_ACTUAL_REASONING_EFFORT
			await recordPreflight("passed")
		} catch (error) {
			await recordPreflight("blocked", error instanceof TestRunError ? error.code : "provider-unavailable")
			throw new Error("Live Copilot preflight blocked; inspect the run-owned preflight artifacts")
		}
	} else if (providerMode !== "scripted" && providerMode !== "vscode-lm-fixture") {
		throw new Error(`Unsupported E2E provider mode: ${providerMode}`)
	}

	await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
	await waitFor(() => api.isReady())

	globalThis.api = api

	const mochaOptions: Mocha.MochaOptions = {
		ui: "tdd",
		timeout: 20 * 60 * 1_000, // 20m
	}

	if (process.env.TEST_GREP) {
		mochaOptions.grep = process.env.TEST_GREP
		console.log(`Running tests matching pattern: ${process.env.TEST_GREP}`)
	}

	const mocha = new Mocha(mochaOptions)
	const cwd = path.resolve(__dirname, "..")

	let testFiles: string[]

	if (process.env.TEST_FILE) {
		const specificFile = process.env.TEST_FILE.endsWith(".js")
			? process.env.TEST_FILE
			: `${process.env.TEST_FILE}.js`

		testFiles = await glob(`**/${specificFile}`, { cwd })
		console.log(`Running specific test file: ${specificFile}`)
	} else {
		testFiles = await glob("**/**.test.js", { cwd })
	}

	if (testFiles.length === 0) {
		hostMetadata.stage = "suite-complete"
		hostMetadata.testCounts = testSuiteOutcome(0).counts
		await recordPreflight("failed", "no-tests-executed")
		throw new TestRunError("no-tests-executed", "No test files matched the selected suite")
	}

	testFiles.forEach((testFile) => mocha.addFile(path.resolve(cwd, testFile)))

	const failureDiagnostics: MochaFailureDiagnostic[] = []
	const outcome = await new Promise<ReturnType<typeof testSuiteOutcome>>((resolve) => {
		const runner = mocha.run((failures) => {
			hostMetadata.failureDiagnostics = failureDiagnostics.length ? [...failureDiagnostics] : undefined
			resolve(testSuiteOutcome(failures, runner.stats))
		})
		runner.on("fail", (runnable, error) => {
			if (failureDiagnostics.length < 8) failureDiagnostics.push(summarizeMochaFailure(runnable, error))
		})
	})
	hostMetadata.stage = "suite-complete"
	hostMetadata.testCounts = outcome.counts
	await recordPreflight(outcome.failure ? "failed" : "passed", outcome.failure)
	if (outcome.failure) {
		throw new TestRunError(outcome.failure, "The selected suite did not produce a passing executed-test receipt")
	}
}
