// Isolated, no-network characterization of the deferred gateway transport defect.
// Run: node artifacts/gap-narrowing-2026-10-20/fix-05-transport-probe.cjs
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { createRequire } = require("node:module")
const { rootCertificates } = require("node:tls")

const repository = path.resolve(__dirname, "../..")
const requireFromRoot = createRequire(path.join(repository, "package.json"))
const requireFromSrc = createRequire(path.join(repository, "src/package.json"))
const ts = requireFromRoot("typescript")

function loadTransport() {
	const source = fs.readFileSync(path.join(repository, "src/api/providers/utils/vertex-gateway-transport.ts"), "utf8")
	const output = ts.transpileModule(source, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.CommonJS,
			esModuleInterop: true,
		},
	}).outputText
	const module = { exports: {} }
	new Function("require", "module", "exports", output)(requireFromSrc, module, module.exports)
	return module.exports
}

async function main() {
	const undici = requireFromSrc("undici")
	const originalFetch = globalThis.fetch
	const originalDispatcher = undici.getGlobalDispatcher()
	const keys = ["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "GLOBAL_AGENT_HTTP_PROXY", "GLOBAL_AGENT_HTTPS_PROXY"]
	const originalEnvironment = new Map(keys.map((key) => [key, process.env[key]]))
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-fix-05-transport-"))
	const createdFiles = []
	const ownedDispatchers = new Set()
	try {
		delete process.env.GLOBAL_AGENT_HTTP_PROXY
		delete process.env.GLOBAL_AGENT_HTTPS_PROXY
		const transport = loadTransport()
		const profiles = ["Stellar", "Vertex OpenAI", "Vertex Gemini", "Anthropic Vertex"]
		const observations = []
		let firstPem
		for (const [index, provider] of profiles.entries()) {
			const pem = path.join(temporary, `profile-${index}.pem`)
			createdFiles.push(pem)
			fs.writeFileSync(pem, rootCertificates[index])
			firstPem ??= pem
			const previousDispatcher = undici.getGlobalDispatcher()
			if (provider === "Stellar") await transport.configurePemCaTransport(pem, provider)
			else await transport.configureVertexGatewayTransport(pem)
			const dispatcher = undici.getGlobalDispatcher()
			if (dispatcher !== originalDispatcher) ownedDispatchers.add(dispatcher)
			observations.push({
				provider,
				fetchChanged: globalThis.fetch !== originalFetch,
				dispatcherChanged: dispatcher !== previousDispatcher,
				environmentChanged: keys.slice(0, 2).every((key) => process.env[key] === pem),
			})
		}
		const debugDispatcher = undici.getGlobalDispatcher()
		process.env.GLOBAL_AGENT_HTTP_PROXY = "http://fixture.invalid:8080"
		await transport.configurePemCaTransport(firstPem, "Stellar")
		console.log(
			JSON.stringify({
				probe: "deferred gateway transport ownership",
				observations,
				priorProfileStillConfiguredAfterOtherProfiles: transport.isVertexGatewayTransportConfiguredForPem(
					createdFiles[2],
				),
				previousPoolsClosedBeforeProbeCleanup: [...ownedDispatchers].slice(0, -1).map((pool) => pool.closed),
				debugProxyDispatcherUnchanged: undici.getGlobalDispatcher() === debugDispatcher,
			}),
		)
	} finally {
		undici.setGlobalDispatcher(originalDispatcher)
		globalThis.fetch = originalFetch
		for (const dispatcher of ownedDispatchers) await dispatcher.close()
		for (const [key, value] of originalEnvironment) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		for (const file of createdFiles) fs.unlinkSync(file)
		fs.rmdirSync(temporary)
	}
	console.log(
		JSON.stringify({
			probe: "probe cleanup",
			fetchRestored: globalThis.fetch === originalFetch,
			dispatcherRestored: undici.getGlobalDispatcher() === originalDispatcher,
			environmentRestored: keys.every((key) => process.env[key] === originalEnvironment.get(key)),
			createdPoolsClosed: [...ownedDispatchers].every((pool) => pool.closed),
			temporaryRemoved: !fs.existsSync(temporary),
		}),
	)
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
