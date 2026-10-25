import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { runExtensionTests, type ExtensionTestRunResult } from "../runTest"
import { isTestExecutionCounts } from "../runFailure"
import { exerciseRenderedAcceptance } from "../ui/renderedAcceptance"
import { exerciseRenderedFileReview } from "../ui/renderedFileReview"
import { exerciseRenderedReasoning } from "../ui/renderedReasoning"
import { exerciseRenderedComposer } from "../ui/renderedComposer"
import { exerciseRenderedRequestUserInput } from "../ui/renderedRequestUserInput"
import { exerciseRenderedTranscriptLifecycle } from "../ui/renderedTranscriptLifecycle"
import { CdpConnection } from "../ui/cdp"
import { waitUntil } from "../evidence/sharedStorageProtocol"

interface Target {
	targetId: string
	type: string
	url: string
}
interface Evaluation<T> {
	result: { value?: T }
	exceptionDetails?: unknown
}

/** Renderer observations only establish acceptance alongside the complete owned host execution. */
export function renderedUiHostAccepted(result: ExtensionTestRunResult, testFile: string): boolean {
	const counts = result.testCounts
	return (
		result.status === "passed" &&
		result.exitCode === 0 &&
		result.execution === "extension-host" &&
		result.providerMode === "scripted" &&
		result.ownershipGate === "verified" &&
		result.captureComplete === true &&
		result.hostExitObserved === true &&
		result.hostCleanupVerified !== false &&
		result.actualVSCodeVersion === "1.138.0" &&
		result.retention?.status === "complete" &&
		result.failure === undefined &&
		result.requireAllTests === true &&
		result.testSelection?.testFile === testFile &&
		result.testSelection.grep === null &&
		result.testSelection.forbidOnly === true &&
		isTestExecutionCounts(counts) &&
		counts.passed > 0 &&
		counts.failed === 0 &&
		counts.pending === 0
	)
}

/** The existing host runner owns profiles, activation, evidence and shutdown for both rendered fixtures. */
export async function runRenderedUiProbe(
	executable: string,
	output: string,
	mode:
		| "probe"
		| "acceptance"
		| "reasoning"
		| "file-review"
		| "composer"
		| "request-user-input"
		| "transcript-lifecycle" = "probe",
	signal?: AbortSignal,
) {
	await fs.mkdir(output, { recursive: true })
	const nonce = randomUUID()
	const profileRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-rendered-probe-"))
	let observed: { status: string; nonce: string; [key: string]: unknown } = { status: "not_started", nonce }
	const runId = `ui-${nonce}`
	const directory = path.join(profileRoot, "evidence", runId)
	const userData = path.join(profileRoot, "profile", "1.138.0", "user-data")
	const abort = new AbortController()
	const combinedSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
	const timer = setTimeout(() => abort.abort(), mode !== "probe" ? 360000 : 120000)
	let hostSettled = false
	const testFile =
		mode === "transcript-lifecycle"
			? "transcript-lifecycle-ui.test"
			: mode === "request-user-input"
				? "request-user-input-ui.test"
				: mode === "composer"
					? "composer-ui.test"
					: mode === "file-review"
						? "file-review-ui.test"
						: mode === "reasoning"
							? "reasoning-ui.test"
							: mode === "acceptance"
								? "managed-agents.acceptance.test"
								: "rendered-ui-probe.test"
	const running = runExtensionTests({
		providerMode: "scripted",
		vscodeVersion: "1.138.0",
		vscodeExecutablePath: executable,
		testFile,
		requireAllTests: true,
		rendererDebuggingPort: 0,
		runId,
		profileDir: path.join(profileRoot, "profile"),
		workspace: path.join(profileRoot, "workspace"),
		artifactsDir: path.join(profileRoot, "evidence"),
		initializeProfile: true,
		retainEvidenceForCampaign: true,
		extensionTestsEnv:
			mode !== "probe" && mode !== "composer"
				? { ALPHA_UI_ACCEPTANCE_NONCE: nonce }
				: { ALPHA_UI_PROBE_NONCE: nonce },
		signal: combinedSignal,
	}).finally(() => {
		hostSettled = true
	})
	void running.catch(() => {})
	let result
	let operationError: unknown
	try {
		let cdp: CdpConnection | undefined
		let lastRenderedText = ""
		try {
			const deadline = Date.now() + 75000
			let activePort = ""
			await waitUntil(
				async () => {
					try {
						combinedSignal.throwIfAborted()
						if (hostSettled) throw new Error("probe_host_closed")
						const ready = JSON.parse(
							await fs.readFile(
								path.join(
									directory,
									mode === "transcript-lifecycle"
										? "ui-stage-transcript-selected.json"
										: mode === "request-user-input"
											? "ui-stage-input-wizard.json"
											: mode === "file-review"
												? "ui-stage-file-review.json"
												: mode === "reasoning"
													? "ui-stage-reasoning-high.json"
													: mode === "acceptance"
														? "ui-stage-settings-edit.json"
														: "ui-ready.json",
								),
								"utf8",
							),
						)
						assert.equal(ready.nonce, nonce)
						assert.equal(ready.version, "1.138.0")
						activePort = await fs.readFile(path.join(userData, "DevToolsActivePort"), "utf8")
						return true
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
						throw error
					}
				},
				deadline,
				"rendered_probe_start_timeout",
			)
			const [port, browserPath] = activePort.trim().split(/\r?\n/)
			assert.match(port!, /^\d{1,5}$/)
			assert.match(browserPath!, /^\/devtools\/browser\/[a-zA-Z0-9-]+$/)
			cdp = await CdpConnection.connect(`ws://127.0.0.1:${port}${browserPath}`)
			const targets = await cdp.request<{ targetInfos: Target[] }>("Target.getTargets")
			const inspected: unknown[] = []
			let selected: { sessionId: string; target: Target } | undefined
			let workbenchSession: string | undefined
			for (const target of targets.targetInfos.filter(
				(value) => value.type === "iframe" || value.type === "page",
			)) {
				const { sessionId } = await cdp.request<{ sessionId: string }>("Target.attachToTarget", {
					targetId: target.targetId,
					flatten: true,
				})
				if (target.type === "page") workbenchSession = sessionId
				const snapshot = await cdp.request<Evaluation<{ text: string; inputs: number }>>(
					"Runtime.evaluate",
					{
						expression:
							"(()=>{const d=document.getElementById('active-frame')?.contentDocument??document;return {text:d.body?.innerText.slice(0,300),inputs:d.querySelectorAll('textarea').length}})()",
						returnByValue: true,
					},
					sessionId,
				)
				inspected.push({ target, snapshot: snapshot.result.value })
				if (
					target.url.includes("extensionId=AlphaInc.alpha") &&
					(mode !== "probe" || snapshot.result.value?.text.includes("Welcome to Alpha"))
				)
					selected = { sessionId, target }
			}
			await fs.writeFile(path.join(directory, "ui-targets.json"), JSON.stringify(inspected, null, 2))
			assert.ok(selected, "No rendered Alpha onboarding target found")
			const { sessionId } = selected
			assert.ok(workbenchSession)
			if (mode !== "probe") {
				const stages = await (
					mode === "transcript-lifecycle"
						? exerciseRenderedTranscriptLifecycle
						: mode === "request-user-input"
							? exerciseRenderedRequestUserInput
							: mode === "composer"
								? exerciseRenderedComposer
								: mode === "file-review"
									? exerciseRenderedFileReview
									: mode === "reasoning"
										? exerciseRenderedReasoning
										: exerciseRenderedAcceptance
				)(cdp, sessionId, workbenchSession, directory, nonce, combinedSignal)
				const modelSwitchTiming =
					mode === "reasoning"
						? JSON.parse(await fs.readFile(path.join(directory, "ui-model-switch-timing.json"), "utf8"))
						: undefined
				const selectionLayout =
					mode === "transcript-lifecycle"
						? JSON.parse(await fs.readFile(path.join(directory, "ui-selection-layout.json"), "utf8"))
						: undefined
				const unattendedLifecycle =
					mode === "transcript-lifecycle"
						? JSON.parse(await fs.readFile(path.join(directory, "ui-unattended-lifecycle.json"), "utf8"))
						: undefined
				observed = {
					status: "passed",
					nonce,
					hostVersion: "1.138.0",
					targetType: selected.target.type,
					trustedInputVerified: true,
					stages,
					provider: "scripted",
					...(modelSwitchTiming ? { modelSwitchTiming } : {}),
					...(selectionLayout ? { selectionLayout } : {}),
					...(unattendedLifecycle ? { unattendedLifecycle } : {}),
				}
			} else {
				await cdp.request("Page.bringToFront", {}, workbenchSession)
				const focused = await cdp.request<Evaluation<boolean>>(
					"Runtime.evaluate",
					{
						expression:
							"(()=>{const d=document.getElementById('active-frame').contentDocument;const button=[...d.querySelectorAll('button')].find(b=>b.textContent.includes('Set up provider'));if(!button)return false;button.focus();return d.activeElement===button})()",
						returnByValue: true,
					},
					sessionId,
				)
				assert.equal(focused.result.value, true)
				await cdp.request(
					"Input.dispatchKeyEvent",
					{ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
					sessionId,
				)
				await cdp.request(
					"Input.dispatchKeyEvent",
					{ type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
					sessionId,
				)
				let settingsText = ""
				await waitUntil(
					async () => {
						const changed = await cdp!.request<Evaluation<string>>(
							"Runtime.evaluate",
							{
								expression:
									"document.getElementById('active-frame').contentDocument.body.innerText.slice(0,1500)",
								returnByValue: true,
							},
							sessionId,
						)
						settingsText = changed.result.value ?? ""
						lastRenderedText = settingsText
						return (
							settingsText.includes("Choose an LLM provider") &&
							!settingsText.includes("Welcome to Alpha")
						)
					},
					Date.now() + 10000,
					"rendered_provider_setup_navigation_timeout",
				)
				await fs.writeFile(path.join(directory, "ui-settings.txt"), settingsText)
				const screenshot = await cdp.request<{ data: string }>(
					"Page.captureScreenshot",
					{ format: "png" },
					workbenchSession,
				)
				await fs.writeFile(path.join(directory, "ui-rendered.png"), Buffer.from(screenshot.data, "base64"))
				observed = {
					status: "passed",
					nonce,
					hostVersion: "1.138.0",
					targetType: selected.target.type,
					targetUrl: selected.target.url,
					trustedInputVerified: true,
					navigationVerified: "welcome-to-provider-setup",
					screenshot: "ui-rendered.png",
					modelRequests: 0,
				}
			}
		} catch (error) {
			observed = {
				status: "failed",
				nonce,
				reason: error instanceof Error ? error.message : "probe_failed",
			}
			if (
				mode === "reasoning" ||
				mode === "file-review" ||
				mode === "request-user-input" ||
				mode === "transcript-lifecycle"
			)
				abort.abort()
		} finally {
			cdp?.close()
			if (
				await fs.stat(directory).then(
					() => true,
					() => false,
				)
			) {
				await fs.writeFile(path.join(directory, "ui-last-rendered.txt"), lastRenderedText)
				await fs.writeFile(path.join(directory, "ui-probe.json"), JSON.stringify(observed, null, 2))
				await fs.writeFile(path.join(directory, "ui-finish.json"), JSON.stringify({ nonce }), {
					flag: "wx",
				})
			}
		}
		result = await running
	} catch (error) {
		operationError = error
		abort.abort()
	} finally {
		clearTimeout(timer)
		try {
			result = await running
		} catch (error) {
			operationError ??= error
		}
	}
	if (operationError) throw operationError
	assert.ok(result)
	if (!renderedUiHostAccepted(result, testFile)) observed.status = "failed"
	await fs.writeFile(
		path.join(output, `ui-probe-${nonce}.json`),
		JSON.stringify({ ...observed, host: result }, null, 2),
	)
	return { ...observed, host: result }
}
