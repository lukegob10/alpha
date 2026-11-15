/**
 * Common interface for all command streams
 */
export interface CommandStream {
	stream: AsyncIterable<string>
	exitCode: number
}

export { createCmdMockStream, createPowerShellMockStream } from "./mockStream"
