const fs = require("node:fs/promises")
const path = require("node:path")
const { createHash } = require("node:crypto")
const vscode = require("vscode")

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function closeAutomationWindow() {
	setTimeout(() => {
		void vscode.commands.executeCommand("workbench.action.closeWindow").catch((error) => {
			console.error(`Could not close the portable automation window: ${String(error)}`)
		})
	}, 250)
}

async function runTask(context, job, api, configuration, model, workspaceAddedByAutomation, workspaceIsUntitled) {
	const directory = context.extensionPath
	const file = (name) => path.join(directory, `${job.runId}-${name}`)
	try {
		await fs.writeFile(file("claim.json"), JSON.stringify({ at: new Date().toISOString() }) + "\n", { flag: "wx" })
	} catch (error) {
		if (error?.code === "EEXIST") return
		throw error
	}
	const events = async (stage, extra = {}) => {
		await fs.appendFile(
			file("events.jsonl"),
			JSON.stringify({ at: new Date().toISOString(), stage, ...extra }) + "\n",
		)
	}
	const outcome = {
		schemaVersion: 1,
		runId: job.runId,
		hostVersion: vscode.version,
		alphaVersion: vscode.extensions.getExtension("AlphaInc.alpha")?.packageJSON.version,
		provider: "vscode-lm",
		model: { id: model.id, family: model.family, vendor: model.vendor },
		reasoningEffort: "max",
		workspace: job.workspace,
		workspaceAddedByAutomation,
		workspaceIsUntitled,
		startedAt: new Date().toISOString(),
		status: "running",
	}
	const provider = api.sidebarProvider
	const overrides = {
		mode: "code",
		approvalMode: "auto",
		autoApprovalEnabled: true,
		alwaysAllowReadOnly: true,
		alwaysAllowReadOnlyOutsideWorkspace: false,
		alwaysAllowWrite: true,
		alwaysAllowWriteOutsideWorkspace: false,
		alwaysAllowWriteProtected: job.allowProtectedWrites === true,
		alwaysAllowExecute: true,
		enableCheckpoints: true,
		alwaysAllowSubagents: false,
		subagentDelegationPolicy: "explicit-only",
		enableReasoningEffort: true,
		reasoningEffort: "max",
		allowedMaxRequests: 80,
	}
	const priorValues = Object.fromEntries(Object.keys(overrides).map((key) => [key, configuration[key]]))
	const browserToolsConfiguration = vscode.workspace.getConfiguration("workbench.browser")
	const priorBrowserTools = browserToolsConfiguration.inspect("enableChatTools")?.globalValue
	const browserConfiguration = vscode.workspace.getConfiguration("chat.tools")
	const priorBrowserApproval = browserConfiguration.inspect("global.autoApprove")?.globalValue
	const browserTestContext = "vscode.chat.tools.global.autoApprove.testMode"
	let browserContextActive = false
	let browserToolsActive = false
	let browserApprovalActive = false
	let taskId
	try {
		const taskConfiguration = { ...configuration, ...overrides }
		if (!path.isAbsolute(job.promptFile)) throw new Error("The task prompt file must be absolute")
		const prompt = await fs.readFile(job.promptFile, "utf8")
		if (!prompt.trim()) throw new Error("The task prompt file is empty")
		if (job.allowBrowserOpen === true) {
			browserToolsActive = true
			await browserToolsConfiguration.update("enableChatTools", true, vscode.ConfigurationTarget.Global)
			await vscode.commands.executeCommand("setContext", browserTestContext, true)
			browserContextActive = true
			browserApprovalActive = true
			await browserConfiguration.update(
				"global.autoApprove",
				{ open_browser_page: true },
				vscode.ConfigurationTarget.Global,
			)
			const browserReadyDeadline = Date.now() + 15_000
			while (
				Date.now() < browserReadyDeadline &&
				!vscode.lm.tools.some((tool) => tool.name === "open_browser_page")
			) {
				await sleep(250)
			}
			const browserTools = vscode.lm.tools
				.filter((tool) =>
					["open_browser_page", "click_element", "read_page", "type_in_page"].includes(tool.name),
				)
				.map((tool) => tool.name)
			await events("browser-tools-checked", { browserTools })
			if (!browserTools.includes("open_browser_page")) {
				throw new Error("VS Code did not register integrated browser tools after enabling them")
			}
		}
		await events("task-starting")
		const taskStartedAt = performance.now()
		taskId = await api.startNewTask({ configuration: taskConfiguration, text: prompt })
		outcome.taskId = taskId
		await events("task-started", { taskId })
		const deadline = Date.now() + Math.min(Math.max(job.timeoutMs ?? 900_000, 60_000), 1_800_000)
		let task
		let lastAsk
		let pendingApprovalSince
		while (Date.now() < deadline) {
			task = provider.getLiveTask(taskId)
			if (task?.checkpointService?.isInitialized && outcome.checkpointReadyMs === undefined) {
				outcome.checkpointReadyMs = performance.now() - taskStartedAt
			}
			const ask = task?.taskAsk?.partial ? undefined : task?.taskAsk?.ask
			if (ask && ask !== lastAsk) {
				lastAsk = ask
				await events("task-ask", { ask })
			}
			const approval = ask === "tool" ? task?.taskAsk?.toolApprovalRequest : undefined
			if (approval) {
				pendingApprovalSince ??= Date.now()
				if (Date.now() - pendingApprovalSince > 20_000) {
					throw new Error(`Alpha requires approval for ${approval.toolName}: ${approval.requestId}`)
				}
			} else {
				pendingApprovalSince = undefined
			}
			if (ask === "completion_result") break
			if (ask === "api_req_failed" || ask === "auto_approval_max_req_reached") {
				throw new Error(`Alpha stopped at ${ask}`)
			}
			if (task?.abort) throw new Error("Alpha task was aborted")
			await sleep(500)
		}
		if (task?.taskAsk?.ask !== "completion_result")
			throw new Error("Alpha task did not reach completion before the deadline")
		outcome.messageCount = task.clineMessages.length
		outcome.checkpoints = {
			requested: true,
			enabledAtCompletion: task.enableCheckpoints,
			initialized: task.checkpointService?.isInitialized === true,
			saved: task.clineMessages.filter((message) => message.say === "checkpoint_saved").length,
		}
		outcome.browserActions = task.clineMessages
			.filter((message) => message.type === "say" && message.say === "tool")
			.flatMap((message) => {
				try {
					const parsed = JSON.parse(message.text ?? "")
					return parsed.tool === "browserAction" ? [{ action: parsed.action, status: parsed.status }] : []
				} catch {
					return []
				}
			})
		await events("task-review", {
			messageCount: outcome.messageCount,
			browserActions: outcome.browserActions.length,
		})

		const beganNew = performance.now()
		await vscode.commands.executeCommand("alpha.plusButtonClicked")
		const newChatMs = performance.now() - beganNew
		await task.waitForTermination()
		const beganCold = performance.now()
		await provider.showTaskWithId(taskId)
		const coldReopenMs = performance.now() - beganCold
		await provider.startBlankTask()
		const beganWarm = performance.now()
		await provider.showTaskWithId(taskId)
		const warmReopenMs = performance.now() - beganWarm
		outcome.navigationMs = { newChatMs, coldReopenMs, warmReopenMs }
		outcome.navigationBoundary = "VS Code command or AlphaProvider method returned; webview paint is not included"
		outcome.inHistory = await api.isTaskInHistory(taskId)
		outcome.status = outcome.inHistory ? "completed" : "failed"
		await events("navigation-complete", { navigationMs: outcome.navigationMs, inHistory: outcome.inHistory })
	} catch (error) {
		outcome.status = "failed"
		outcome.error = error instanceof Error ? error.message : String(error)
		await events("failed", { error: outcome.error })
	} finally {
		const activeTask = taskId ? provider.getLiveTask(taskId) : undefined
		if (activeTask && activeTask.taskAsk?.ask !== "completion_result") {
			try {
				await activeTask.abortTask()
			} catch (error) {
				await events("cleanup-error", { operation: "abort", error: String(error) })
			}
		}
		try {
			await provider.setValues(priorValues)
		} catch (error) {
			outcome.status = "failed"
			outcome.error = `${outcome.error ? `${outcome.error}; ` : ""}Could not restore test-profile settings: ${String(error)}`
			await events("cleanup-error", { operation: "restore-settings", error: String(error) })
		}
		if (browserApprovalActive) {
			try {
				await browserConfiguration.update(
					"global.autoApprove",
					priorBrowserApproval,
					vscode.ConfigurationTarget.Global,
				)
			} catch (error) {
				outcome.status = "failed"
				outcome.error = `${outcome.error ? `${outcome.error}; ` : ""}Could not restore browser approvals: ${String(error)}`
				await events("cleanup-error", { operation: "restore-browser-approvals", error: String(error) })
			}
		}
		if (browserContextActive) {
			try {
				await vscode.commands.executeCommand("setContext", browserTestContext, false)
			} catch (error) {
				outcome.status = "failed"
				outcome.error = `${outcome.error ? `${outcome.error}; ` : ""}Could not clear browser approval context: ${String(error)}`
				await events("cleanup-error", { operation: "clear-browser-context", error: String(error) })
			}
		}
		if (browserToolsActive) {
			try {
				await browserToolsConfiguration.update(
					"enableChatTools",
					priorBrowserTools,
					vscode.ConfigurationTarget.Global,
				)
			} catch (error) {
				outcome.status = "failed"
				outcome.error = `${outcome.error ? `${outcome.error}; ` : ""}Could not restore browser tool setting: ${String(error)}`
				await events("cleanup-error", { operation: "restore-browser-tools", error: String(error) })
			}
		}
		outcome.finishedAt = new Date().toISOString()
		outcome.dirtyEditorsAtFinish = vscode.workspace.textDocuments.filter((document) => document.isDirty).length
		await fs.writeFile(file("task-result.json"), JSON.stringify(outcome, null, 2) + "\n", { flag: "wx" })
		closeAutomationWindow()
	}
}

async function activate(context) {
	const runPath = path.join(context.extensionPath, "run.json")
	let job
	try {
		job = JSON.parse(await fs.readFile(runPath, "utf8"))
	} catch {
		return
	}
	const write = async (name, value) => {
		await fs.writeFile(
			path.join(context.extensionPath, `${job.runId}-${name}`),
			JSON.stringify(value, null, 2) + "\n",
			{
				flag: "wx",
			},
		)
	}
	const report = {
		schemaVersion: 1,
		runId: job.runId,
		stage: "activating",
		hostVersion: vscode.version,
		at: new Date().toISOString(),
	}
	try {
		if (!/^[a-z0-9-]{1,64}$/.test(job.runId)) throw new Error("Invalid automation run ID")
		if (!path.isAbsolute(job.workspace)) throw new Error("The automation workspace must be absolute")
		const expectedWorkspace = path.resolve(job.workspace).toLowerCase()
		let workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		const workspaceDeadline = Date.now() + 2_000
		while (Date.now() < workspaceDeadline && path.resolve(workspace ?? "").toLowerCase() !== expectedWorkspace) {
			await sleep(100)
			workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		}
		if (!workspace) {
			await new Promise((resolve, reject) => {
				const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
					clearTimeout(timeout)
					listener.dispose()
					resolve()
				})
				const timeout = setTimeout(() => {
					listener.dispose()
					reject(new Error("The fixture workspace did not open"))
				}, 10_000)
				const changed = vscode.workspace.updateWorkspaceFolders(0, 0, { uri: vscode.Uri.file(job.workspace) })
				if (!changed) {
					clearTimeout(timeout)
					listener.dispose()
					reject(new Error("Could not add the fixture folder to the test window"))
				}
			})
			report.workspaceAddedByAutomation = true
			workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		}
		report.workspace = workspace ?? null
		report.workspaceIsUntitled = vscode.workspace.workspaceFile?.scheme === "untitled"
		if (!workspace || path.resolve(workspace).toLowerCase() !== expectedWorkspace) {
			throw new Error("Workspace does not match the automation fixture")
		}
		if (vscode.version !== "1.125.0") throw new Error("The host is not VS Code 1.125.0")
		const alpha = vscode.extensions.getExtension("AlphaInc.alpha")
		if (!alpha) {
			report.visibleProviderExtensions = vscode.extensions.all
				.map((extension) => extension.id)
				.filter((id) => /alpha|copilot/i.test(id))
			throw new Error("Alpha is not available in this VS Code window")
		}
		const api = await alpha.activate()
		const configuration = api.getConfiguration()
		const settings = await api.sidebarProvider.getState()
		const models = await vscode.lm.selectChatModels({ vendor: "copilot" })
		const selectedId = configuration.vsCodeLmModelSelector?.id
		const selectedModel = models.find((model) => model.id === selectedId)
		if (!selectedModel) throw new Error("The configured Copilot model is unavailable in this VS Code window")
		report.stage = "ready"
		report.alphaVersion = alpha.packageJSON.version
		report.alphaExtensionPath = alpha.extensionPath
		report.alphaBundleSha256 = createHash("sha256")
			.update(await fs.readFile(path.join(alpha.extensionPath, "dist", "extension.js")))
			.digest("hex")
		report.provider = configuration.apiProvider
		report.selectedModel = configuration.vsCodeLmModelSelector
		report.providerConfiguration = {
			vsCodeLmContextSize: configuration.vsCodeLmContextSize ?? null,
			reasoningEnabled: configuration.enableReasoningEffort ?? null,
			reasoningEffort: configuration.reasoningEffort ?? null,
		}
		report.contextSettings = {
			autoCondenseContext: settings.autoCondenseContext,
			autoCondenseContextPercent: settings.autoCondenseContextPercent,
			autoCondenseContextScope: settings.autoCondenseContextScope,
			postTurnCondenseContextPercent: settings.postTurnCondenseContextPercent,
		}
		report.approvalSettings = {
			approvalMode: settings.approvalMode,
			alwaysAllowWrite: settings.alwaysAllowWrite,
			alwaysAllowWriteProtected: settings.alwaysAllowWriteProtected,
			alwaysAllowExecute: settings.alwaysAllowExecute,
		}
		report.selectedModelMaxInputTokens = selectedModel.maxInputTokens
		report.modelCatalog = models.map((model) => ({ id: model.id, family: model.family, vendor: model.vendor }))
		report.dirtyEditorsAtFinish = vscode.workspace.textDocuments.filter((document) => document.isDirty).length
		await write("probe-result.json", report)
		if (job.mode === "task") {
			void runTask(
				context,
				job,
				api,
				configuration,
				selectedModel,
				report.workspaceAddedByAutomation === true,
				report.workspaceIsUntitled,
			).catch((error) => {
				console.error(
					`Alpha portable automation failed: ${error instanceof Error ? error.message : String(error)}`,
				)
			})
		} else if (job.mode === "probe") {
			closeAutomationWindow()
		} else {
			throw new Error("Unknown automation mode")
		}
	} catch (error) {
		report.stage = "failed"
		report.error = error instanceof Error ? error.message : String(error)
		report.workspaceIsUntitled ??= vscode.workspace.workspaceFile?.scheme === "untitled"
		report.dirtyEditorsAtFinish = vscode.workspace.textDocuments.filter((document) => document.isDirty).length
		await write("probe-result.json", report)
		closeAutomationWindow()
	}
}

exports.activate = activate
