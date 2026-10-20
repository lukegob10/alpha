import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

import { runExtensionTests, type ExtensionTestRunResult } from "./runTest"
import { requireHeldRetentionReceipt } from "./campaign/retentionReceipt"
import { readBounded } from "./evidence/paths"
import { waitUntil } from "./evidence/sharedStorageProtocol"
import { writeJsonAtomically } from "./suite/preflightEvidence"
import { CdpConnection } from "./ui/cdp"
import { javascriptLiteral } from "./ui/javascriptLiteral"
import {
	createEditorReloadProvider,
	EDITOR_RELOAD_COMPLETION,
	EDITOR_RELOAD_FRESH_INPUT,
	EDITOR_RELOAD_MARKERS,
	EDITOR_RELOAD_VERSION,
	parseEditorReloadTaskIds,
} from "./scenarios/editorChatReloadFixture"

type Target = { targetId: string; type: string; url: string }
type Stage = { nonce: string; stage: string; version: string; pid: number; taskIds?: string[] }

export function assertEditorReloadHostPair(runs: readonly ExtensionTestRunResult[]): void {
	assert.equal(runs.length, 2, "The restart proof requires two completed owned host launches")
	for (const run of runs) {
		assert.equal(run.actualVSCodeVersion, EDITOR_RELOAD_VERSION)
		assert.equal(run.execution, "extension-host")
		assert.equal(run.launchKind, "development-sidecar")
		assert.equal(run.status, "passed")
		assert.equal(run.exitCode, 0)
		assert.equal(run.completionStatus, "passed")
		assert.equal(run.ownershipGate, "verified")
		assert.equal(run.hostExitObserved, true)
		assert.equal(run.captureComplete, true)
		assert.ok(run.evidenceManifestPath)
		assert.ok(Number.isSafeInteger(run.extensionHostPid) && run.extensionHostPid! > 0)
	}
	assert.notEqual(
		runs[0]!.extensionHostPid,
		runs[1]!.extensionHostPid,
		"Reopen must use a different extension-host process",
	)
	assert.equal(runs[0]!.userDataDir, runs[1]!.userDataDir, "Both hosts must use the same owned profile")
	assert.equal(runs[0]!.workspace, runs[1]!.workspace)
}

async function evaluate<T>(connection: CdpConnection, session: string, expression: string): Promise<T> {
	const result = await connection.request<{ result: { value: T }; exceptionDetails?: unknown }>(
		"Runtime.evaluate",
		{
			expression: `(()=>{const d=document.getElementById('active-frame')?.contentDocument??document;return (${expression})})()`,
			returnByValue: true,
			awaitPromise: true,
		},
		session,
	)
	assert.equal(result.exceptionDetails, undefined, "The renderer observation must execute successfully")
	return result.result.value
}

async function connectRenderer(profile: string, signal: AbortSignal) {
	let endpoint = ""
	await waitUntil(
		async () => {
			signal.throwIfAborted()
			try {
				endpoint = await fs.readFile(
					path.join(profile, EDITOR_RELOAD_VERSION, "user-data", "DevToolsActivePort"),
					"utf8",
				)
				return endpoint.trim().length > 0
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
				throw error
			}
		},
		Date.now() + 60_000,
		"editor_reload_debug_endpoint",
	)
	const [port, browserPath] = endpoint.trim().split(/\r?\n/)
	assert.match(port ?? "", /^\d{1,5}$/)
	assert.match(browserPath ?? "", /^\/devtools\/browser\/[A-Za-z0-9-]+$/)
	return CdpConnection.connect(`ws://127.0.0.1:${port}${browserPath}`)
}

async function findEditorFrames(connection: CdpConnection, signal: AbortSignal) {
	const sessions = new Map<string, string>()
	let frames: string[] = []
	let workbench = ""
	await waitUntil(
		async () => {
			signal.throwIfAborted()
			const { targetInfos } = await connection.request<{ targetInfos: Target[] }>("Target.getTargets")
			const selected = new Map<string, string>()
			for (const target of targetInfos) {
				if (
					!(target.type === "page" && target.url.includes("workbench")) &&
					!target.url.includes("extensionId=AlphaInc.alpha")
				)
					continue
				let session = sessions.get(target.targetId)
				if (!session) {
					session = (
						await connection.request<{ sessionId: string }>("Target.attachToTarget", {
							targetId: target.targetId,
							flatten: true,
						})
					).sessionId
					sessions.set(target.targetId, session)
				}
				if (target.type === "page") workbench = session
				else {
					const text = await evaluate<string>(connection, session, "d.body?.innerText??''")
					for (const marker of EDITOR_RELOAD_MARKERS) if (text.includes(marker)) selected.set(marker, session)
				}
			}
			frames = EDITOR_RELOAD_MARKERS.flatMap((marker) => (selected.has(marker) ? [selected.get(marker)!] : []))
			return frames.length === 2 && new Set(frames).size === 2 && !!workbench
		},
		Date.now() + 60_000,
		"editor_reload_distinct_rendered_chats",
	)
	return { frames, workbench }
}

function phase(
	root: string,
	executable: string,
	nonce: string,
	name: "seed" | "reopen",
	baseUrl: string,
	taskIds?: string[],
) {
	const runId = `editor-${name}-${nonce}`
	const directory = path.join(root, "evidence", runId)
	const abort = new AbortController()
	const timer = setTimeout(() => abort.abort(), 210_000)
	let result: ExtensionTestRunResult | undefined
	const running = runExtensionTests(
		{
			providerMode: "scripted",
			vscodeVersion: EDITOR_RELOAD_VERSION,
			vscodeExecutablePath: executable,
			profileDir: path.join(root, "profile"),
			workspace: path.join(root, "workspace"),
			artifactsDir: path.join(root, "evidence"),
			initializeProfile: name === "seed",
			runId,
			testFile: "editor-chat-reload.test",
			rendererDebuggingPort: 0,
			requireAllTests: true,
			retainEvidenceForCampaign: true,
			signal: abort.signal,
			extensionTestsEnv: {
				ALPHA_UI_ACCEPTANCE_NONCE: nonce,
				ALPHA_EDITOR_RELOAD_PHASE: name,
				ALPHA_EDITOR_RELOAD_BASE_URL: baseUrl,
				ALPHA_EDITOR_RELOAD_TASK_IDS: JSON.stringify(taskIds ?? []),
			},
		},
		{ launchKind: "development-sidecar" },
	)
		.then((observed) => {
			result = observed
			return observed
		})
		.finally(() => clearTimeout(timer))
	const ended = running.then((observed) => {
		throw new Error(
			`${name} host ended with ${observed.status} before completing the editor reload stage; inspect ${path.join(directory, "host-preflight.json")}`,
		)
	})
	void ended.catch(() => undefined)
	return {
		abort,
		running,
		directory,
		get result() {
			return result
		},
		async ready(stage: string): Promise<Stage> {
			let receipt!: Stage
			await Promise.race([
				ended,
				waitUntil(
					async () => {
						abort.signal.throwIfAborted()
						try {
							receipt = JSON.parse(
								(await readBounded(path.join(directory, `ui-stage-${stage}.json`), 4096)).toString(
									"utf8",
								),
							) as Stage
							assert.equal(receipt.nonce, nonce)
							assert.equal(receipt.stage, stage)
							assert.equal(receipt.version, EDITOR_RELOAD_VERSION)
							return true
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
							throw error
						}
					},
					Date.now() + 75_000,
					`editor_reload_${name}_${stage}`,
				),
			])
			return receipt
		},
		async acknowledge(stage: string) {
			await writeJsonAtomically(
				path.join(directory, `ui-done-${stage}.json`),
				{ nonce, stage, status: "passed" },
				{ rename: fs.link },
			)
		},
	}
}

/** Two real Code processes; VS Code restores the panels from its own saved webview state. */
export async function runEditorChatReload(executable: string, output: string) {
	assert.ok(path.isAbsolute(executable), "An explicit exact-host executable is required")
	assert.ok(path.isAbsolute(output), "Editor reload evidence requires an absolute directory")
	await fs.mkdir(output, { recursive: true })
	const root = await fs.mkdtemp(path.join(output, "run-"))
	const nonce = randomUUID()
	const provider = await createEditorReloadProvider()
	const runs: ExtensionTestRunResult[] = []
	let active: ReturnType<typeof phase> | undefined
	let connection: CdpConnection | undefined
	try {
		active = phase(root, executable, nonce, "seed", provider.baseUrl)
		const seeded = await active.ready("seeded")
		const taskIds = parseEditorReloadTaskIds(seeded.taskIds)
		connection = await connectRenderer(path.join(root, "profile"), active.abort.signal)
		const seedFrames = await findEditorFrames(connection, active.abort.signal)
		for (const frame of seedFrames.frames)
			await evaluate(
				connection,
				frame,
				"new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))",
			)
		assert.equal(provider.requests.length, 0, "Seeding and saving drafts must not invoke a model")
		await active.acknowledge("seeded")
		connection.close()
		connection = undefined
		runs.push(await active.running)
		assert.equal(runs[0]!.status, "passed")
		await requireHeldRetentionReceipt(runs[0]!.artifactsDir, runs[0]!.runId, runs[0]!.retentionResultPath)
		for (const pid of new Set([
			runs[0]!.launchedHostPid,
			runs[0]!.extensionHostPid,
			runs[0]!.extensionHostParentPid,
		])) {
			assert.ok(Number.isSafeInteger(pid) && pid! > 0)
			assert.throws(
				() => process.kill(pid!, 0),
				(error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
				"Every owned seed process must exit before profile reuse",
			)
		}

		active = phase(root, executable, nonce, "reopen", provider.baseUrl, [...taskIds])
		const restored = await active.ready("restored")
		assert.notEqual(restored.pid, seeded.pid)
		assert.deepEqual(restored.taskIds, seeded.taskIds)
		connection = await connectRenderer(path.join(root, "profile"), active.abort.signal)
		const reopenedFrames = await findEditorFrames(connection, active.abort.signal)
		assert.equal(
			provider.requests.length,
			0,
			"Native panel restoration must retain drafts without invoking a model",
		)
		await active.acknowledge("restored")
		await active.ready("newer-view")
		assert.equal(
			await evaluate<boolean>(
				connection,
				reopenedFrames.frames[0]!,
				"!!d.querySelector('.new-task-composer textarea')",
			),
			true,
		)
		assert.equal(provider.requests.length, 0)
		await active.acknowledge("newer-view")
		await active.ready("continue-ready")
		await waitUntil(
			() =>
				evaluate<boolean>(
					connection!,
					reopenedFrames.frames[0]!,
					`d.body.innerText.includes(${javascriptLiteral(EDITOR_RELOAD_MARKERS[0])})&&!!d.querySelector('textarea')`,
				),
			Date.now() + 15_000,
			"editor_reload_continuation_render",
		)
		assert.equal(provider.requests.length, 0, "No startup or navigation event authorizes queued input submission")
		await connection.request("Page.bringToFront", {}, reopenedFrames.workbench)
		assert.equal(
			await evaluate<boolean>(
				connection,
				reopenedFrames.frames[0]!,
				"(()=>{const input=d.querySelector('textarea');const win=d.defaultView;win.__alphaEditorReloadInputTrusted=false;input.addEventListener('keydown',event=>{if(event.key==='Enter')win.__alphaEditorReloadInputTrusted=event.isTrusted},{once:true});input.focus();return d.activeElement===input})()",
			),
			true,
		)
		await connection.request("Input.insertText", { text: EDITOR_RELOAD_FRESH_INPUT }, reopenedFrames.frames[0])
		for (const type of ["keyDown", "keyUp"])
			await connection.request(
				"Input.dispatchKeyEvent",
				{
					type,
					key: "Enter",
					code: "Enter",
					windowsVirtualKeyCode: 13,
					...(type === "keyDown" ? { text: "\r" } : {}),
				},
				reopenedFrames.frames[0],
			)
		assert.equal(
			await evaluate<boolean>(
				connection,
				reopenedFrames.frames[0]!,
				"d.defaultView.__alphaEditorReloadInputTrusted===true",
			),
			true,
			"The continuation must originate from a trusted renderer key event",
		)
		await active.acknowledge("continue-ready")
		await active.ready("completed")
		await waitUntil(
			() =>
				evaluate<boolean>(
					connection!,
					reopenedFrames.frames[0]!,
					`d.body.innerText.includes(${javascriptLiteral(EDITOR_RELOAD_COMPLETION)})`,
				),
			Date.now() + 15_000,
			"editor_reload_completion_painted",
		)
		assert.ok(
			provider.requests.some((request) => request.firstDraft),
			"Saved first-chat draft must reach its provider",
		)
		assert.ok(
			provider.requests.some((request) => request.freshContinuation),
			"Fresh human continuation must reach its provider",
		)
		assert.equal(
			provider.requests.some((request) => request.secondDraft),
			false,
			"Second-chat draft cannot cross into the resumed chat",
		)
		assert.equal(
			provider.requests.some((request) => request.streaming),
			false,
		)
		await active.acknowledge("completed")
		connection.close()
		connection = undefined
		runs.push(await active.running)
		assertEditorReloadHostPair(runs)
		await requireHeldRetentionReceipt(runs[1]!.artifactsDir, runs[1]!.runId, runs[1]!.retentionResultPath)
		const reportPath = path.join(root, "editor-chat-reload-report.json")
		await fs.writeFile(
			reportPath,
			JSON.stringify(
				{
					schemaVersion: 1,
					status: "passed",
					hostVersion: EDITOR_RELOAD_VERSION,
					realProcessRestart: true,
					nativeSerializer: true,
					zeroRequestsBeforeFreshInput: true,
					requests: provider.requests,
					runs,
				},
				null,
				2,
			),
			{ flag: "wx" },
		)
		return { status: "passed" as const, root, reportPath }
	} catch (error) {
		const failedHost = active?.result
		if (failedHost && !runs.some((run) => run.runId === failedHost.runId)) runs.push(failedHost)
		const reportPath = path.join(root, "editor-chat-reload-failed.json")
		await fs.writeFile(
			reportPath,
			JSON.stringify(
				{
					schemaVersion: 1,
					status: "failed",
					hostVersion: EDITOR_RELOAD_VERSION,
					requests: provider.requests,
					runs,
				},
				null,
				2,
			),
			{ flag: "wx" },
		)
		throw new Error(`Editor chat reload failed; inspect retained evidence in ${root}`, { cause: error })
	} finally {
		connection?.close()
		active?.abort.abort()
		await active?.running.catch(() => undefined)
		await provider.close()
	}
}

if (require.main === module) {
	void runEditorChatReload(
		process.env.VSCODE_EXECUTABLE_PATH ?? "",
		process.env.ALPHA_EDITOR_RELOAD_OUTPUT ?? path.join(os.tmpdir(), "alpha-editor-chat-reload"),
	)
		.then((result) => console.log(JSON.stringify(result)))
		.catch((error: unknown) => {
			console.error(error)
			process.exitCode = 1
		})
}
