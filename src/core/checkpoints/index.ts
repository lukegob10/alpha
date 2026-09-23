import * as vscode from "vscode"

import type { AlphaApiReqInfo } from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"

import { Task } from "../task/Task"

import { getWorkspacePath } from "../../utils/path"
import { checkGitInstalled } from "../../utils/git"
import { t } from "../../i18n"

import { getApiMetrics } from "../../shared/getApiMetrics"

import { DIFF_VIEW_URI_SCHEME } from "../../integrations/editor/DiffViewProvider"

import { awaitTaskCancellationBoundary } from "../webview/TaskCancellationBoundary"

import { CheckpointServiceOptions, RepoPerTaskCheckpointService } from "../../services/checkpoints"

const WARNING_THRESHOLD_MS = 5000

type CheckpointService = RepoPerTaskCheckpointService

type CheckpointInitializationState = {
	promise: Promise<CheckpointService | undefined>
	resolve: (service: CheckpointService | undefined) => void
	settled: boolean
	warningTimer?: ReturnType<typeof setTimeout>
	timeoutTimer?: ReturnType<typeof setTimeout>
	warningShown: boolean
	timeoutShown: boolean
}

// Initialization is intentionally shared per task. The task loop starts it in the
// background, while checkpoint operations that arrive before it completes join the
// same promise instead of polling the task every 250ms.
const checkpointInitializationStates = new WeakMap<Task, CheckpointInitializationState>()

function sendCheckpointInitWarn(task: Task, type?: "WAIT_TIMEOUT" | "INIT_TIMEOUT", timeout?: number) {
	task.providerRef.deref()?.postMessageToWebview({
		type: "checkpointInitWarning",
		checkpointWarning: type && timeout ? { type, timeout } : undefined,
	})
}

export async function getCheckpointService(task: Task, _options: { interval?: number } = {}) {
	if (!task.enableCheckpoints) {
		return undefined
	}

	if (task.checkpointService?.isInitialized) {
		return task.checkpointService
	}

	let state = checkpointInitializationStates.get(task)
	if (!state) {
		const created = createCheckpointInitializationState()
		state = created.state
		checkpointInitializationStates.set(task, state)
		scheduleCheckpointInitializationTimeout(task, state)
		created.start(task)

		// The task loop intentionally starts this promise without awaiting it. The
		// creator follows that same background-start behavior; later callers join it
		// and arm the wait warning. The deadline covers the whole initialization.
		return state.promise
	}

	scheduleCheckpointInitializationTimeout(task, state)
	armCheckpointInitializationWarning(task, state)
	return state.promise
}

function createCheckpointInitializationState(): {
	state: CheckpointInitializationState
	start: (task: Task) => void
} {
	let resolveInitialization!: (service: CheckpointService | undefined) => void

	const promise = new Promise<CheckpointService | undefined>((resolve) => {
		resolveInitialization = resolve
	})

	const state: CheckpointInitializationState = {
		promise,
		resolve: resolveInitialization,
		settled: false,
		warningShown: false,
		timeoutShown: false,
	}

	return {
		state,
		start: (task) => {
			// The state is placed in the WeakMap before this work can be observed by
			// another task operation. Always settle the shared promise, even if a
			// future change introduces an uncaught initialization error.
			void initializeCheckpointService(task).then(
				(service) => {
					finishCheckpointInitialization(task, state, service)
				},
				(error) => {
					task.enableCheckpoints = false
					console.error("[Task#getCheckpointService] unexpected initialization failure", error)
					finishCheckpointInitialization(task, state, undefined)
				},
			)
		},
	}
}

function scheduleCheckpointInitializationTimeout(task: Task, state: CheckpointInitializationState) {
	if (state.settled || state.timeoutTimer) {
		return
	}

	state.timeoutTimer = setTimeout(() => {
		if (state.settled || checkpointInitializationStates.get(task) !== state) {
			return
		}

		if (task.enableCheckpoints) {
			state.timeoutShown = true
			sendCheckpointInitWarn(task, "INIT_TIMEOUT", task.checkpointTimeout)
			task.enableCheckpoints = false
		}
		task.checkpointServiceInitializing = false
		finishCheckpointInitialization(task, state, undefined)
	}, task.checkpointTimeout * 1000)
}

function armCheckpointInitializationWarning(task: Task, state: CheckpointInitializationState) {
	if (state.settled || state.warningTimer) {
		return
	}

	state.warningTimer = setTimeout(() => {
		state.warningTimer = undefined

		// A timeout warning belongs to this exact initialization attempt. Do not
		// publish it after a newer attempt or after initialization has settled.
		if (
			!state.settled &&
			checkpointInitializationStates.get(task) === state &&
			task.enableCheckpoints &&
			!state.warningShown
		) {
			state.warningShown = true
			sendCheckpointInitWarn(task, "WAIT_TIMEOUT", WARNING_THRESHOLD_MS / 1000)
		}
	}, WARNING_THRESHOLD_MS)
}

function finishCheckpointInitialization(
	task: Task,
	state: CheckpointInitializationState,
	service: CheckpointService | undefined,
) {
	if (state.settled) {
		return
	}

	state.settled = true
	if (state.warningTimer) {
		clearTimeout(state.warningTimer)
		state.warningTimer = undefined
	}
	if (state.timeoutTimer) {
		clearTimeout(state.timeoutTimer)
		state.timeoutTimer = undefined
	}

	const canPublishService =
		!!service &&
		service.isInitialized &&
		task.enableCheckpoints &&
		checkpointInitializationStates.get(task) === state

	if (canPublishService) {
		task.checkpointService = service
		sendCheckpointInitWarn(task)
	}

	// Initialization can fail after the five-second wait warning but before the
	// shared timeout. Remove that stale warning when the underlying operation has
	// finished; timeout failures intentionally keep their terminal warning visible.
	if (!canPublishService && state.warningShown && !state.timeoutShown) {
		sendCheckpointInitWarn(task)
	}

	state.resolve(canPublishService ? service : undefined)
}

async function initializeCheckpointService(task: Task): Promise<CheckpointService | undefined> {
	const provider = task.providerRef.deref()

	const log = (message: string) => {
		console.log(message)

		try {
			provider?.log(message)
		} catch (err) {
			// NO-OP
		}
	}

	console.log("[Task#getCheckpointService] initializing checkpoints service")
	task.checkpointServiceInitializing = true

	try {
		const workspaceDir = task.cwd || getWorkspacePath()

		if (!workspaceDir) {
			log("[Task#getCheckpointService] workspace folder not found, disabling checkpoints")
			task.enableCheckpoints = false
			return undefined
		}

		const globalStorageDir = provider?.context.globalStorageUri.fsPath

		if (!globalStorageDir) {
			log("[Task#getCheckpointService] globalStorageDir not found, disabling checkpoints")
			task.enableCheckpoints = false
			return undefined
		}

		const options: CheckpointServiceOptions = {
			taskId: task.taskId,
			workspaceDir,
			shadowDir: globalStorageDir,
			log,
		}

		const service = task.checkpointService ?? RepoPerTaskCheckpointService.create(options)
		const gitAvailable = await checkGitInstallation(task, service, log, provider)

		// Git absence or initialization failure disables checkpoints. The shared
		// completion handler decides whether a successfully initialized service may
		// still be published; this prevents a timed-out attempt from publishing late
		// if a caller re-enables checkpoints while the underlying work finishes.
		if (!gitAvailable || !service.isInitialized) {
			return undefined
		}

		return service
	} catch (err) {
		log(`[Task#getCheckpointService] ${err.message}`)
		task.enableCheckpoints = false
		return undefined
	} finally {
		task.checkpointServiceInitializing = false
	}
}

async function checkGitInstallation(
	task: Task,
	service: RepoPerTaskCheckpointService,
	log: (message: string) => void,
	provider: any,
): Promise<boolean> {
	try {
		const gitCheckStartTime = Date.now()
		const gitInstalled = await checkGitInstalled()
		log(`[Task#getCheckpointService] Git availability check ${Date.now() - gitCheckStartTime}ms`)

		if (!gitInstalled) {
			log("[Task#getCheckpointService] Git is not installed, disabling checkpoints")
			task.enableCheckpoints = false
			task.checkpointServiceInitializing = false

			// Keep the user notification asynchronous so all checkpoint waiters can
			// settle immediately when Git is unavailable.
			void Promise.resolve(
				vscode.window.showWarningMessage(t("common:errors.git_not_installed"), t("common:buttons.learn_more")),
			)
				.then((selection) => {
					if (selection === t("common:buttons.learn_more")) {
						return vscode.env.openExternal(vscode.Uri.parse("https://git-scm.com/downloads"))
					}
					return undefined
				})
				.catch((error) => {
					log(`[Task#getCheckpointService] failed to show Git notification: ${error.message}`)
				})

			return false
		}

		// Git is installed, proceed with initialization
		service.on("initialize", () => {
			log("[Task#getCheckpointService] service initialized")
			task.checkpointServiceInitializing = false
		})

		service.on("checkpoint", ({ fromHash: from, toHash: to, suppressMessage }) => {
			try {
				sendCheckpointInitWarn(task)
				// Always update the current checkpoint hash in the webview, including the suppress flag
				provider?.postMessageToWebview({
					type: "currentCheckpointUpdated",
					text: to,
					suppressMessage: !!suppressMessage,
				})

				// Always create the chat message but include the suppress flag in the payload
				// so the chatview can choose not to render it while keeping it in history.
				task.say(
					"checkpoint_saved",
					to,
					undefined,
					undefined,
					{ from, to, suppressMessage: !!suppressMessage },
					undefined,
					{ isNonInteractive: true },
				).catch((err) => {
					log("[Task#getCheckpointService] caught unexpected error in say('checkpoint_saved')")
					console.error(err)
				})
			} catch (err) {
				log("[Task#getCheckpointService] caught unexpected error in on('checkpoint'), disabling checkpoints")
				console.error(err)
				task.enableCheckpoints = false
			}
		})

		log("[Task#getCheckpointService] initializing shadow git")

		try {
			await service.initShadowGit()
			return service.isInitialized
		} catch (err) {
			log(`[Task#getCheckpointService] initShadowGit -> ${err.message}`)
			task.enableCheckpoints = false
			return false
		}
	} catch (err) {
		log(`[Task#getCheckpointService] Unexpected error during Git check: ${err.message}`)
		console.error("Git check error:", err)
		task.enableCheckpoints = false
		task.checkpointServiceInitializing = false
		return false
	}
}

export async function checkpointSave(task: Task, force = false, suppressMessage = false) {
	const service = await getCheckpointService(task)

	if (!service) {
		return
	}

	TelemetryService.instance.captureCheckpointCreated(task.taskId)

	// Start the checkpoint process in the background.
	return service
		.saveCheckpoint(`Task: ${task.taskId}, Time: ${Date.now()}`, { allowEmpty: force, suppressMessage })
		.catch((err) => {
			console.error("[Task#checkpointSave] caught unexpected error, disabling checkpoints", err)
			task.enableCheckpoints = false
		})
}

export type CheckpointRestoreOptions = {
	ts: number
	commitHash: string
	mode: "preview" | "restore"
	operation?: "delete" | "edit" // Optional to maintain backward compatibility
}

export async function checkpointRestore(
	task: Task,
	{ ts, commitHash, mode, operation = "delete" }: CheckpointRestoreOptions,
) {
	const service = await getCheckpointService(task)

	if (!service) {
		return false
	}

	const index = task.clineMessages.findIndex((m) => m.ts === ts)

	if (index === -1) {
		return false
	}

	const provider = task.providerRef.deref()

	try {
		// Workspace restoration and transcript rewind must not race the task that
		// currently owns the workspace. Abort the active task first, then join its
		// real termination/persistence boundary before replacing either resource.
		let abortResult: unknown
		if (!task.abort && typeof task.abortTask === "function") {
			abortResult = await task.abortTask()
		}
		await awaitTaskCancellationBoundary(task, abortResult)

		await service.restoreCheckpoint(commitHash)
		TelemetryService.instance.captureCheckpointRestored(task.taskId)
		await provider?.postMessageToWebview({ type: "currentCheckpointUpdated", text: commitHash })

		if (mode === "restore") {
			// Calculate metrics from messages that will be deleted (must be done before rewind)
			const deletedMessages = task.clineMessages.slice(index + 1)

			const { totalTokensIn, totalTokensOut, totalCacheWrites, totalCacheReads, totalCost } = getApiMetrics(
				task.combineMessages(deletedMessages),
			)

			// Use MessageManager to properly handle context-management events
			// This ensures orphaned Summary messages and truncation markers are cleaned up
			await task.messageManager.rewindToTimestamp(ts, {
				includeTargetMessage: operation === "edit",
			})

			// The task is stopped; say() correctly rejects new agent output after abort.
			// Persist the host's accounting row through the transcript owner instead.
			await task.overwriteAlphaMessages([
				...task.clineMessages,
				{
					ts: Math.max(Date.now(), (task.clineMessages.at(-1)?.ts ?? 0) + 1),
					type: "say",
					say: "api_req_deleted",
					text: JSON.stringify({
						tokensIn: totalTokensIn,
						tokensOut: totalTokensOut,
						cacheWrites: totalCacheWrites,
						cacheReads: totalCacheReads,
						cost: totalCost,
					} satisfies AlphaApiReqInfo),
				},
			])
			await provider?.postStateToWebview()
		}
		return true
	} catch (err) {
		provider?.log("[checkpointRestore] disabling checkpoints for this task")
		task.enableCheckpoints = false
		throw err
	}
}

export type CheckpointDiffOptions = {
	ts?: number
	previousCommitHash?: string
	commitHash: string
	/**
	 * from-init: Compare from the first checkpoint to the selected checkpoint.
	 * checkpoint: Compare the selected checkpoint to the next checkpoint.
	 * to-current: Compare the selected checkpoint to the current workspace.
	 * full: Compare from the first checkpoint to the current workspace.
	 */
	mode: "from-init" | "checkpoint" | "to-current" | "full"
}

export async function checkpointDiff(task: Task, { ts, previousCommitHash, commitHash, mode }: CheckpointDiffOptions) {
	const service = await getCheckpointService(task)

	if (!service) {
		return
	}

	TelemetryService.instance.captureCheckpointDiffed(task.taskId)

	let fromHash: string | undefined
	let toHash: string | undefined
	let title: string

	const checkpoints = task.clineMessages.filter(({ say }) => say === "checkpoint_saved").map(({ text }) => text!)

	if (["from-init", "full"].includes(mode) && checkpoints.length < 1) {
		vscode.window.showInformationMessage(t("common:errors.checkpoint_no_first"))
		return
	}

	const idx = checkpoints.indexOf(commitHash)
	switch (mode) {
		case "checkpoint":
			fromHash = commitHash
			toHash = idx !== -1 && idx < checkpoints.length - 1 ? checkpoints[idx + 1] : undefined
			title = t("common:errors.checkpoint_diff_with_next")
			break
		case "from-init":
			fromHash = checkpoints[0]
			toHash = commitHash
			title = t("common:errors.checkpoint_diff_since_first")
			break
		case "to-current":
			fromHash = commitHash
			toHash = undefined
			title = t("common:errors.checkpoint_diff_to_current")
			break
		case "full":
			fromHash = checkpoints[0]
			toHash = undefined
			title = t("common:errors.checkpoint_diff_since_first")
			break
	}

	if (!fromHash) {
		vscode.window.showInformationMessage(t("common:errors.checkpoint_no_previous"))
		return
	}

	try {
		const changes = await service.getDiff({ from: fromHash, to: toHash })

		if (!changes?.length) {
			vscode.window.showInformationMessage(t("common:errors.checkpoint_no_changes"))
			return
		}

		await vscode.commands.executeCommand(
			"vscode.changes",
			title,
			changes.map((change) => [
				vscode.Uri.file(change.paths.absolute),
				vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${change.paths.relative}`).with({
					query: Buffer.from(change.content.before ?? "").toString("base64"),
				}),
				vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${change.paths.relative}`).with({
					query: Buffer.from(change.content.after ?? "").toString("base64"),
				}),
			]),
		)
	} catch (err) {
		const provider = task.providerRef.deref()
		provider?.log("[checkpointDiff] disabling checkpoints for this task")
		task.enableCheckpoints = false
	}
}
