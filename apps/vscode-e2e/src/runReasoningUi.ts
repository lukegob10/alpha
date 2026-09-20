import * as path from "node:path"
import { downloadAndUnzipVSCode } from "@vscode/test-electron"
import { runRenderedUiProbe } from "./campaign/renderedUiProbe"

async function main() {
	const executable = await downloadAndUnzipVSCode({ version: "1.122.1" })
	const output = path.resolve(__dirname, "../../../artifacts/reasoning-ui")
	const result = await runRenderedUiProbe(executable, output, "reasoning")
	console.log(JSON.stringify(result))
	if (result.status !== "passed") process.exitCode = 1
}

void main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
