/* Read-only behavioral probes. Execute current method bodies with controlled host adapters. */
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const EventEmitter = require("node:events")
const { createRequire } = require("node:module")

const root = path.resolve(__dirname, "../..")
const requireFromSrc = createRequire(path.join(root, "src/package.json"))
const ts = requireFromSrc("typescript")

function method(file, className, name, bindings) {
	const filename = path.join(root, file)
	const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true)
	const owner = source.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === className)
	const declaration = owner.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(source) === name)
	assert.ok(declaration, `Method exists: ${className}.${name}`)
	const text = declaration.getText(source).replace(/^(?:(?:private|public|protected|override)\s+)+/, "")
	const compiled = ts.transpileModule(`({${text}})`, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
	}).outputText
	return new Function(...Object.keys(bindings), `return ${compiled}`)(...Object.values(bindings))[name]
}

const events = new Proxy({}, { get: (_target, key) => String(key) })
const bindings = {
	AlphaCodeEventName: events,
	taskReasoningPreferenceSchema: { parse: (value) => value },
	defaultModeSlug: "code",
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS: 15,
	experimentDefault: {},
	migrateApprovalMode: () => "ask",
	resolveSubagentOrchestrationSettings: () => ({ delegationPolicy: "disabled" }),
	resolveSubagentDelegationPolicy: () => ({ policy: "disabled" }),
	assertSupportedApiProvider: () => undefined,
	normalizeMaxLiveTasks: (value) => value,
	DEFAULT_MAX_CONCURRENT_TASKS: 3,
	vscode: { window: { showErrorMessage: () => undefined } },
	hasFiniteTaskCallLimit: () => false,
	assertPrimaryMode: () => undefined,
	cancelPromptEnhancements: () => undefined,
	McpServerManager: { unregisterProvider: async () => undefined },
	AlphaProvider: { activeInstances: new Set() },
}
let nextId = 0
bindings.Task = class extends EventEmitter {
	constructor(options) {
		super()
		this.taskId = `probe-${++nextId}`
		this.instanceId = this.taskId
		this.taskKind = "primary"
		this.options = options
	}
	start() { this.started = true }
}

const providerMethods = {}
for (const name of ["createTask", "createTaskUnderCreationLock", "dispose", "disposeOwnedResources"]) {
	providerMethods[name] = method("src/core/webview/AlphaProvider.ts", "AlphaProvider", name, bindings)
}

function fixture() {
	const sessions = new Map()
	const provider = Object.assign({}, providerMethods, {
		_disposed: false,
		taskHistoryStoreReady: Promise.resolve(),
		taskCreationQueue: Promise.resolve(),
		configurationQueue: Promise.resolve(),
		contextProxy: { getValues: () => ({}), getValue: () => undefined },
		getProviderSettingsSnapshot: () => ({ apiProvider: "fake-ai" }),
		newTaskDraftMode: "code",
		getTaskOwner: () => undefined,
		finalizeActiveCompletionCandidate: async () => undefined,
		removeTaskFromStack: async () => undefined,
		updateGlobalState: async () => undefined,
		taskStack: [],
		taskCreationCallback: () => undefined,
		addTaskToStack: async (task) => sessions.set(task.taskId, task),
		postTaskStateToWebview: async () => undefined,
		postTaskSessionStateToWebview: async () => undefined,
		log: () => undefined,
		taskSessions: {
			canCreateTask: () => false,
			getMaxLiveTasks: () => 1,
			getOwnedTasks: () => [...sessions.values()],
			disposeView: () => { provider.viewDetached = true },
		},
		webviewMessageQueue: Promise.resolve(),
		taskControlMessageQueues: new Map(),
		immediateWebviewOperations: new Set(),
		subagentResidencyEvictions: new Map(),
		clearWebviewResources: () => undefined,
		closeAgentLifecycleJournals: async () => undefined,
		disposables: [],
		mcpHubInitialization: Promise.resolve(),
		flushGlobalStateWriteThrough: async () => undefined,
		taskHistoryStore: { dispose: async () => { provider.historyDisposed = true } },
		removeAllListeners: () => undefined,
	})
	return { provider, sessions }
}

async function main() {
	const full = fixture()
	const task = await full.provider.createTask("API new-tab task", undefined, undefined, {
		apiConfiguration: { apiProvider: "fake-ai" },
	})
	assert.equal(task.started, true)
	assert.equal(full.sessions.size, 1)
	await assert.rejects(full.provider.createTask("Webview task", undefined, undefined, {
		apiConfiguration: { apiProvider: "fake-ai" }, preserveExisting: true,
	}), /Maximum live task limit reached/)
	console.log("CONFIRMED: full capacity rejects preserveExisting=true but admits the API option shape.")

	const closing = fixture()
	let releaseConfiguration
	let enteredConfiguration
	const entered = new Promise((resolve) => { enteredConfiguration = resolve })
	const hold = new Promise((resolve) => { releaseConfiguration = resolve })
	closing.provider.configurationQueue = { then: (resolve, reject) => {
		enteredConfiguration()
		return hold.then(resolve, reject)
	} }
	const creation = closing.provider.createTask("API task racing panel close", undefined, undefined, {
		apiConfiguration: { apiProvider: "fake-ai" },
	})
	await entered
	await closing.provider.dispose()
	assert.equal(closing.provider._disposed, true)
	assert.equal(closing.provider.historyDisposed, true)
	assert.equal(closing.provider.viewDetached, true)
	assert.equal(closing.sessions.size, 0)
	releaseConfiguration()
	const late = await creation
	assert.equal(late.started, true)
	assert.equal(closing.sessions.size, 1)
	console.log("CONFIRMED: creation awaiting configuration can register and start after dispose() has completed.")

	const provider = new EventEmitter()
	const api = Object.assign(new EventEmitter(), { fileLog: async () => undefined })
	method("src/extension/api.ts", "API", "registerListeners", { AlphaCodeEventName: events }).call(api, provider)
	const observed = []
	api.on(events.TaskCompleted, (...args) => observed.push(args))
	const child = Object.assign(new EventEmitter(), { taskId: "child", parentTaskId: "root", taskKind: "subagent" })
	provider.emit(events.TaskCreated, child)
	child.emit(events.TaskCompleted, child.taskId, { totalTokensIn: 1 }, {})
	assert.equal(observed.length, 1)
	assert.equal(provider.listenerCount(events.TaskCompleted), 0)
	console.log("CONFIRMED: API publishes raw child completion without observing the provider durable completion event.")
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
