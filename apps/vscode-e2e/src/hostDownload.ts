import { downloadAndUnzipVSCode, type DownloadOptions } from "@vscode/test-electron"

const vscodeDownloadIdleTimeoutMs = 60_000

export async function downloadTestVSCode(
	options: Partial<DownloadOptions>,
	signal?: AbortSignal,
	download: (options: Partial<DownloadOptions>) => Promise<string> = downloadAndUnzipVSCode,
): Promise<string> {
	const settings = { ...options, timeout: options.timeout ?? vscodeDownloadIdleTimeoutMs }
	try {
		return await download(settings)
	} catch (error) {
		// vscode-test retries archive transfers internally. Version resolution happens before those retries.
		if (
			signal?.aborted ||
			!(error instanceof Error) ||
			!error.message.startsWith("@vscode/test-electron request timeout ")
		) {
			throw error
		}
		console.warn("VS Code download timed out. Retrying the requested version once.")
		return download(settings)
	}
}
