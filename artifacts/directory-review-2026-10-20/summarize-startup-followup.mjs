import { readFile, writeFile } from "node:fs/promises"

async function summarizeHost(basename, expectedVersion, expectedFiles) {
	const lines = (await readFile(new URL(`../${basename}.log`, import.meta.url), "utf8")).split(/\r?\n/)
	let file
	const suites = []
	for (const line of lines) {
		const match = line.match(/Running specific test file: (.+)/)
		if (match) file = match[1]
		if (!line.startsWith('{"runId"')) continue
		const result = JSON.parse(line)
		suites.push({
			file,
			runId: result.runId,
			version: result.actualVSCodeVersion,
			provider: result.providerMode,
			status: result.status,
			counts: result.testCounts,
			requireAllTests: result.requireAllTests,
			hostExitObserved: result.hostExitObserved,
			exitCode: result.exitCode,
		})
	}
	const allPassed = suites.length === expectedFiles && suites.every((suite) =>
		suite.version === expectedVersion && suite.status === "passed" && suite.exitCode === 0 &&
		suite.requireAllTests === true && suite.hostExitObserved === true &&
		suite.counts?.failed === 0 && suite.counts?.pending === 0,
	)
	return {
		source: `artifacts/${basename}.log`, expectedVersion, expectedFiles,
		totalPassed: suites.reduce((sum, suite) => sum + (suite.counts?.passed ?? 0), 0), allPassed, suites,
	}
}

async function startupSamples(basename) {
	const text = await readFile(new URL(`../${basename}.log`, import.meta.url), "utf8")
	const line = text.split(/\r?\n/).find((entry) => entry.startsWith("[first-prompt-latency] "))
	if (!line) throw new Error(`Missing startup measurements: ${basename}`)
	const report = JSON.parse(line.slice("[first-prompt-latency] ".length))
	return {
		source: `artifacts/${basename}.log`, hostVersion: report.hostVersion, boundary: report.boundary,
		loggedConditions: report.conditions,
		samples: report.samples.map(({ sample, taskCreatedMs, firstRequestMs }) => ({ sample, taskCreatedMs, firstRequestMs })),
	}
}

const result = {
	status: "startup_followup_complete_receipts_verified",
	ownerReport: "docs/first-prompt-latency-2026-10-20.md",
	referenceSmoke: await summarizeHost("first-prompt-smoke-1380", "1.138.0", 13),
	minimumCompatibilityRunner: await summarizeHost("first-prompt-compatibility-1250", "1.125.0", 4),
	before: await startupSamples("first-prompt-baseline"),
	after: await startupSamples("first-prompt-after"),
	conditionsCorrection: "Each task releases its scoped skills catalog; each sample discovers a fresh catalog while filesystem caches remain warm. The original baseline metadata described later catalogs as warm incorrectly.",
	storageBeforeAfter: { injectedDelayPerReadMs: 50, before: { reads: 2, ms: 100 }, after: { reads: 1, ms: 50 } },
	renderedAdmission: JSON.parse(await readFile(new URL("startup-rendered-admission.json", import.meta.url), "utf8")),
	renderedScreenshot: "artifacts/directory-review-2026-10-20/startup-first-prompt-pending.png",
	limitations: [
		"The minimum-host runner reuses rebuilt extension/webview outputs rather than executing the full build wrapper again.",
		"The earlier minimum-host overlap failure remains unexplained; the startup repair is not established as its cause or fix.",
		"Both provider-entry samples bypass saved-profile lookup and exclude composer transport, renderer paint, and real provider/network latency.",
		"Three samples per series do not establish a general speedup or diagnose multi-second live delays.",
	],
}
if (!result.referenceSmoke.allPassed || !result.minimumCompatibilityRunner.allPassed) {
	throw new Error("Follow-up host receipts do not satisfy the stated exact-version inventories")
}
await writeFile(new URL("startup-followup-validation.json", import.meta.url), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({
	referenceSmoke: { suites: result.referenceSmoke.suites.length, passed: result.referenceSmoke.totalPassed },
	minimumCompatibilityRunner: { suites: result.minimumCompatibilityRunner.suites.length, passed: result.minimumCompatibilityRunner.totalPassed },
	before: result.before.samples, after: result.after.samples,
}, null, 2))
