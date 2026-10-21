import { readFile, writeFile } from "node:fs/promises"

const [basename, expectedVersion, expectedSuiteCountText] = process.argv.slice(2)
if (!/^host-[a-z0-9-]+$/.test(basename ?? "") || !/^\d+\.\d+\.\d+$/.test(expectedVersion ?? "")) {
	throw new Error("Expected an owned host log basename and exact version")
}
const lines = (await readFile(new URL(`${basename}.log`, import.meta.url), "utf8")).split(/\r?\n/)
let file
const suites = []
for (const line of lines) {
	const match = line.match(/Running specific test file: (.+)/)
	if (match) file = match[1]
	if (!line.startsWith('{"runId"')) continue
	const record = JSON.parse(line)
	suites.push({
		file,
		actualVSCodeVersion: record.actualVSCodeVersion,
		providerMode: record.providerMode,
		status: record.status,
		requireAllTests: record.requireAllTests,
		testCounts: record.testCounts,
		hostExitObserved: record.hostExitObserved,
		exitCode: record.exitCode,
	})
}
const summary = {
	expectedVersion,
	expectedSuiteCount: Number(expectedSuiteCountText),
	suiteCount: suites.length,
	totalPassed: suites.reduce((sum, suite) => sum + (suite.testCounts?.passed ?? 0), 0),
	allPassed:
		suites.length === Number(expectedSuiteCountText) &&
		suites.every(
			(suite) =>
				suite.status === "passed" &&
				suite.exitCode === 0 &&
				suite.actualVSCodeVersion === expectedVersion &&
				suite.requireAllTests === true &&
				suite.hostExitObserved === true &&
				suite.testCounts?.pending === 0 &&
				suite.testCounts?.failed === 0,
		),
	suites,
}
await writeFile(new URL(`${basename}-summary.json`, import.meta.url), `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(summary, null, 2))
