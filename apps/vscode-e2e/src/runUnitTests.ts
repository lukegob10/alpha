import { spawn } from "child_process"
import * as path from "path"
import { glob } from "glob"

async function main(): Promise<void> {
	// Pass concrete paths so Windows does not depend on shell wildcard expansion.
	const files = (await glob("**/*.spec.js", { cwd: __dirname, absolute: true, ignore: ["suite/**"] })).sort()
	if (files.length === 0) throw new Error("No unit tests were compiled")
	const child = spawn(
		process.execPath,
		["--test", "--test-concurrency=2", ...files.map((file) => path.normalize(file))],
		{
			stdio: "inherit",
			windowsHide: true,
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
