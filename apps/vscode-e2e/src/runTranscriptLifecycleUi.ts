import * as path from "node:path"
import { downloadTestVSCode } from "./hostDownload"
import { runRenderedUiProbe } from "./campaign/renderedUiProbe"

async function main() {
	const executable = await downloadTestVSCode({ version: "1.141.0" })
	const output = path.resolve(__dirname, "../../../artifacts/transcript-lifecycle-ui")
	const result = await runRenderedUiProbe(executable, output, "transcript-lifecycle")
	console.log(JSON.stringify(result))
	if (result.status !== "passed") process.exitCode = 1
}

void main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
