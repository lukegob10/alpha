// streamUtils/mockStream.ts
import type { CommandStream } from "./index"

/**
 * Base function to create a mock stream with predefined output for testing without executing real commands
 * @param output The output to return in the stream
 * @param exitCode The exit code to return
 * @returns An object containing the stream and exit code
 */
function createBaseMockStream(output: string, exitCode: number = 0): CommandStream {
	const stream = {
		async *[Symbol.asyncIterator]() {
			// Start marker
			yield "\x1b]633;C\x07"

			// Yield the output
			if (output.length > 0) {
				yield output
			}

			// End marker
			yield "\x1b]633;D\x07"
		},
	}

	return { stream, exitCode }
}

/**
 * Creates a mock stream for CMD output
 * @param output The output to return in the stream
 * @param exitCode The exit code to return
 * @returns An object containing the stream and exit code
 */
export function createCmdMockStream(output: string, exitCode: number = 0): CommandStream {
	// For CMD, we ensure Windows-style line endings
	const windowsOutput = output.replace(/\n/g, "\r\n").replace(/\r\r\n/g, "\r\n")
	return createBaseMockStream(windowsOutput, exitCode)
}

/**
 * Creates a mock stream for PowerShell output
 * @param output The output to return in the stream
 * @param exitCode The exit code to return
 * @returns An object containing the stream and exit code
 */
export function createPowerShellMockStream(output: string, exitCode: number = 0): CommandStream {
	// For PowerShell, we normalize to Unix-style line endings as the real implementation does
	const normalizedOutput = output.replace(/\r\n/g, "\n")
	return createBaseMockStream(normalizedOutput, exitCode)
}
