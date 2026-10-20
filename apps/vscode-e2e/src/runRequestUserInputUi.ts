import * as fs from "node:fs/promises"
import * as path from "node:path"
import { downloadAndUnzipVSCode } from "@vscode/test-electron"
import { runRenderedUiProbe } from "./campaign/renderedUiProbe"

async function main() {
	const executable = await downloadAndUnzipVSCode({ version: "1.138.0" })
	const output = path.resolve(__dirname, "../../../artifacts/request-user-input-ui")
	const result = await runRenderedUiProbe(executable, output, "request-user-input")
	const directory = path.join(output, result.host.runId)
	await fs.cp(result.host.artifactsDir, directory, { recursive: true })
	console.log(JSON.stringify({ ...result, directory }))
	if (result.status !== "passed") process.exitCode = 1
}

void main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
