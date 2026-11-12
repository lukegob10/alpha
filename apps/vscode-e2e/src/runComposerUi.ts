import * as path from "node:path"
import { downloadTestVSCode } from "./hostDownload"
import { runRenderedUiProbe } from "./campaign/renderedUiProbe"

async function main() {
	const executable = await downloadTestVSCode({ version: "1.141.0" })
	const output = path.resolve(__dirname, "../../../artifacts/composer-ui")
	const result = await runRenderedUiProbe(executable, output, "composer")
	console.log(JSON.stringify(result))
	if (result.status !== "passed") process.exitCode = 1
}

void main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
