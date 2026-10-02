import { spawn } from "child_process"
import * as path from "path"
import { pathToFileURL } from "node:url"
import { glob } from "glob"

/** Unit fixtures cannot publish host-lane receipts; retain the structured Node reporter's separate destination. */
export function unitTestEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const unitEnv = { ...env }
	delete unitEnv.ALPHA_HARNESS_EVIDENCE_DIR
	return unitEnv
}

async function main(): Promise<void> {
	// Pass concrete paths so Windows does not depend on shell wildcard expansion.
	const files = (await glob("**/*.spec.js", { cwd: __dirname, absolute: true, ignore: ["suite/**"] })).sort()
	if (files.length === 0) throw new Error("No unit tests were compiled")
	const child = spawn(
		process.execPath,
		[
			"--test",
			"--test-concurrency=2",
			...(process.env.ALPHA_HARNESS_EVIDENCE_FILE
				? [
						"--test-reporter=spec",
						`--test-reporter=${pathToFileURL(path.resolve(__dirname, "../../../scripts/harness/node-reporter.mjs")).href}`,
						"--test-reporter-destination=stdout",
						"--test-reporter-destination=stdout",
					]
				: []),
			...files.map((file) => path.normalize(file)),
		],
		{
			stdio: "inherit",
			windowsHide: true,
			env: unitTestEnvironment(process.env),
		},
	)
	const code = await new Promise<number>((resolve, reject) => {
		child.once("error", reject)
		child.once("exit", (status) => resolve(status ?? 1))
	})
	process.exitCode = code
}

if (require.main === module) {
	main().catch(() => {
		console.error("Unable to run compiled unit tests")
		process.exitCode = 1
	})
}
