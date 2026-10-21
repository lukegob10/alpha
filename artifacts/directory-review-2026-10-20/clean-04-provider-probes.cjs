// Read-only audit probes. Run from any directory with Node 24:
// node artifacts/directory-review-2026-10-20/clean-04-provider-probes.cjs
// No network requests or actual credential commands are made.
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const { createRequire } = require("node:module")

process.chdir(path.resolve(__dirname, "../.."))
const requireFromRoot = createRequire(path.resolve("package.json"))
const requireFromSrc = createRequire(path.resolve("src/package.json"))
const ts = requireFromRoot("typescript")

function load(source, dependency = requireFromSrc, extra = {}) {
	const output = ts.transpileModule(source, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.CommonJS,
			esModuleInterop: true,
		},
	}).outputText
	const module = { exports: {} }
	new Function("require", "module", "exports", ...Object.keys(extra), output)(
		dependency,
		module,
		module.exports,
		...Object.values(extra),
	)
	return module.exports
}

async function main() {
	const undici = requireFromSrc("undici")
	const previousFetch = globalThis.fetch
	const previousDispatcher = undici.getGlobalDispatcher()
	const previousPemEnvironment = [process.env.SSL_CERT_FILE, process.env.NODE_EXTRA_CA_CERTS]
	const previousProxyEnvironment = [process.env.GLOBAL_AGENT_HTTP_PROXY, process.env.GLOBAL_AGENT_HTTPS_PROXY]
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-provider-audit-"))
	const createdDispatchers = []
	try {
		delete process.env.GLOBAL_AGENT_HTTP_PROXY
		delete process.env.GLOBAL_AGENT_HTTPS_PROXY
		const transport = load(fs.readFileSync("src/api/providers/utils/vertex-gateway-transport.ts", "utf8"))
		const roots = require("node:tls").rootCertificates
		const firstPem = path.join(temporary, "first.pem")
		const secondPem = path.join(temporary, "second.pem")
		fs.writeFileSync(firstPem, roots[0])
		fs.writeFileSync(secondPem, roots[1])
		await transport.configurePemCaTransport(firstPem)
		const firstDispatcher = undici.getGlobalDispatcher()
		createdDispatchers.push(firstDispatcher)
		await transport.configurePemCaTransport(secondPem)
		const secondDispatcher = undici.getGlobalDispatcher()
		createdDispatchers.push(secondDispatcher)
		console.log(JSON.stringify({
			probe: "global transport",
			fetchReplaced: globalThis.fetch !== previousFetch,
			firstDispatcherReplaced: previousDispatcher !== firstDispatcher,
			secondDispatcherReplaced: firstDispatcher !== secondDispatcher,
			firstDispatcherClosed: firstDispatcher.closed,
			firstProfileStillConfigured: transport.isVertexGatewayTransportConfiguredForPem(firstPem),
		}))
	} finally {
		undici.setGlobalDispatcher(previousDispatcher)
		globalThis.fetch = previousFetch
		for (const dispatcher of createdDispatchers) await dispatcher.close()
		for (const [key, value] of [
			["SSL_CERT_FILE", previousPemEnvironment[0]],
			["NODE_EXTRA_CA_CERTS", previousPemEnvironment[1]],
			["GLOBAL_AGENT_HTTP_PROXY", previousProxyEnvironment[0]],
			["GLOBAL_AGENT_HTTPS_PROXY", previousProxyEnvironment[1]],
		]) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		for (const file of ["first.pem", "second.pem"]) {
			const generatedFile = path.join(temporary, file)
			if (fs.existsSync(generatedFile)) fs.unlinkSync(generatedFile)
		}
		fs.rmdirSync(temporary)
	}

	const vertexSource = fs.readFileSync("src/api/providers/vertex-openai.ts", "utf8")
	const wrapperSource = "export " + vertexSource.slice(vertexSource.indexOf("function asVertexOpenAiError("))
	const wrapper = load(wrapperSource).asVertexOpenAiError
	const sourceError = Object.assign(new Error("Retry later"), {
		status: 429,
		retryAfterMs: 60_000,
		retryable: false,
		retryCategory: "rate-limit",
	})
	sourceError.name = "ProviderError"
	const wrapped = wrapper(sourceError)
	console.log(JSON.stringify({
		probe: "gateway retry metadata",
		status: wrapped.status,
		name: wrapped.name,
		hasRetryAfter: "retryAfterMs" in wrapped,
		hasRetryable: "retryable" in wrapped,
		hasRetryCategory: "retryCategory" in wrapped,
	}))

	const timers = []
	let commandCalls = 0
	const { HelixTokenManager } = load(
		fs.readFileSync("src/api/providers/utils/helix-token-manager.ts", "utf8"),
		(name) => name === "node:child_process" ? {
			exec: (_command, _options, callback) => {
				commandCalls++
				callback(null, "synthetic-token-12345678901234567890", "")
			},
		} : requireFromSrc(name),
		{
			setTimeout: (callback, delay) => {
				const timer = { callback, delay, unref() {} }
				timers.push(timer)
				return timer
			},
			clearTimeout: () => {},
		},
	)
	await HelixTokenManager.getOrCreate({ helixCommand: "first-profile", refreshIntervalMinutes: 10 }).getToken()
	await HelixTokenManager.getOrCreate({ helixCommand: "second-profile", refreshIntervalMinutes: 10 }).getToken()
	timers[0].callback()
	await Promise.resolve()
	await Promise.resolve()
	await Promise.resolve()
	console.log(JSON.stringify({
		probe: "retired token manager",
		disposeAvailable: typeof HelixTokenManager.prototype.dispose === "function",
		retainedManagers: HelixTokenManager.instances.size,
		commandCallsAfterOldTimer: commandCalls,
		scheduledTimers: timers.length,
	}))

	const converter = load(
		fs.readFileSync("src/api/transform/gemini-format.ts", "utf8"),
		(name) => name === "./tool-history" ? {
			normalizeToolHistory: (messages) => messages,
			toFunctionToolInput: (_name, input) => input,
		} : name === "../../i18n" ? { t: (key) => key } : requireFromSrc(name),
	)
	const replay = converter.convertAnthropicContentToGemini([
		{ type: "text", text: "First source part." },
		{ type: "text", text: "Last source part." },
		{ type: "thoughtSignature", thoughtSignature: "signature-from-last-source-part" },
	])
	console.log(JSON.stringify({
		probe: "Gemini signature position",
		originalSignedPart: "last",
		replaySignedIndexes: replay.flatMap((part, index) => part.thoughtSignature ? [index] : []),
		replay,
	}))
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
