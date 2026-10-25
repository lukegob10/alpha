export function commandReceipt(exitCode, output) {
	return { status: "success", exitCode: exitCode || 0, output: output.trim() }
}
