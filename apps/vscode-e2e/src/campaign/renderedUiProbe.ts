import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { runExtensionTests } from "../runTest"
import { exerciseRenderedAcceptance } from "../ui/renderedAcceptance"
import { exerciseRenderedReasoning } from "../ui/renderedReasoning"
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

/** The existing host runner owns profiles, activation, evidence and shutdown for both rendered fixtures. */
export async function runRenderedUiProbe(
	executable: string,
	output: string,
	mode: "probe" | "acceptance" | "reasoning" = "probe",
	signal?: AbortSignal,
) {
	await fs.mkdir(output, { recursive: true })
	const nonce = randomUUID()
	const profileRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-rendered-probe-"))
	let observed: { status: string; nonce: string; [key: string]: unknown } = { status: "not_started", nonce }
	const runId = `ui-${nonce}`
	const directory = path.join(profileRoot, "evidence", runId)
	const userData = path.join(profileRoot, "profile", "1.122.1", "user-data")
	const abort = new AbortController()
	const combinedSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
	const timer = setTimeout(() => abort.abort(), mode !== "probe" ? 360000 : 120000)
	let hostSettled = false
	const running = runExtensionTests({
		providerMode: "scripted",
		vscodeVersion: "1.122.1",
		vscodeExecutablePath: executable,
		testFile:
			mode === "reasoning"
				? "reasoning-ui.test"
				: mode === "acceptance"
					? "managed-agents.acceptance.test"
					: "rendered-ui-probe.test",
		rendererDebuggingPort: 0,
		runId,
		profileDir: path.join(profileRoot, "profile"),
		workspace: path.join(profileRoot, "workspace"),
		artifactsDir: path.join(profileRoot, "evidence"),
		initializeProfile: true,
		retainEvidenceForCampaign: true,
		extensionTestsEnv: mode !== "probe" ? { ALPHA_UI_ACCEPTANCE_NONCE: nonce } : { ALPHA_UI_PROBE_NONCE: nonce },
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
									mode === "reasoning"
										? "ui-stage-reasoning-high.json"
										: mode === "acceptance"
											? "ui-stage-settings-edit.json"
											: "ui-ready.json",
								),
								"utf8",
							),
						)
						assert.equal(ready.nonce, nonce)
						assert.equal(ready.version, "1.122.1")
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
				const stages = await (mode === "reasoning" ? exerciseRenderedReasoning : exerciseRenderedAcceptance)(
					cdp,
					sessionId,
					workbenchSession,
					directory,
					nonce,
					combinedSignal,
				)
				observed = {
					status: "passed",
					nonce,
					hostVersion: "1.122.1",
					targetType: selected.target.type,
					trustedInputVerified: true,
					stages,
					provider: "scripted",
				}
			} else {
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
					{ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
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
					hostVersion: "1.122.1",
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
			if (mode === "reasoning") abort.abort()
		} finally {
			await fs.writeFile(path.join(directory, "ui-last-rendered.txt"), lastRenderedText)
			cdp?.close()
			await fs.writeFile(path.join(directory, "ui-probe.json"), JSON.stringify(observed, null, 2))
			await fs.writeFile(path.join(directory, "ui-finish.json"), JSON.stringify({ nonce }), {
				flag: "wx",
			})
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
	if (
		result.status !== "passed" ||
		result.execution !== "extension-host" ||
		result.ownershipGate !== "verified" ||
		result.captureComplete !== true ||
		result.hostExitObserved !== true ||
		result.actualVSCodeVersion !== "1.122.1"
	)
		observed.status = "failed"
	await fs.writeFile(
		path.join(output, `ui-probe-${nonce}.json`),
		JSON.stringify({ ...observed, host: result }, null, 2),
	)
	return { ...observed, host: result }
}
