import * as os from "node:os"
import * as path from "node:path"
import { downloadAndUnzipVSCode } from "@vscode/test-electron"
import { runRenderedUiProbe } from "./campaign/renderedUiProbe"

async function main() {
	const executable = await downloadAndUnzipVSCode({ version: "1.141.0" })
	const output = path.resolve(process.env.ALPHA_SETTINGS_UI_OUTPUT ?? path.join(os.tmpdir(), "alpha-settings-ui"))
	const result = await runRenderedUiProbe(executable, output, "settings")
	console.log(JSON.stringify({ ...result, output }))
	if (result.status !== "passed") process.exitCode = 1
}

void main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
