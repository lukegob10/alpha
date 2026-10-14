import { execa } from "execa"

import type { ProcessResult, ProcessRunner, ProcessSpec } from "./types"

function capOutput(value: string, maxBytes: number): { value: string; bytes: number; truncated: boolean } {
	const buffer = Buffer.from(value)
	if (buffer.byteLength <= maxBytes) return { value, bytes: buffer.byteLength, truncated: false }
	const capped = buffer.subarray(0, maxBytes).toString("utf8")
	return { value: capped, bytes: Buffer.byteLength(capped), truncated: true }
}

export class ExecaProcessRunner implements ProcessRunner {
	async run(spec: ProcessSpec): Promise<ProcessResult> {
		const startedAt = performance.now()
		try {
			const result = await execa(spec.command, spec.args, {
				cwd: spec.cwd,
				reject: false,
				timeout: spec.timeoutMs,
				killSignal: "SIGKILL",
				maxBuffer: spec.maxOutputBytes * 2,
			})
			const stdout = capOutput(result.stdout ?? "", spec.maxOutputBytes)
			const stderr = capOutput(result.stderr ?? "", spec.maxOutputBytes)
			return {
				exitCode: result.exitCode ?? null,
				stdout: stdout.value,
				stderr: stderr.value,
				durationMs: Math.round(performance.now() - startedAt),
				timedOut: result.timedOut,
				outputTruncated: stdout.truncated || stderr.truncated,
			}
		} catch (error) {
			const value = error as {
				stdout?: string
				stderr?: string
				exitCode?: number
				timedOut?: boolean
				message?: string
			}
			const stdout = capOutput(value.stdout ?? "", spec.maxOutputBytes)
			const stderr = capOutput(value.stderr ?? value.message ?? String(error), spec.maxOutputBytes)
			if (value.timedOut) {
				return {
					exitCode: value.exitCode ?? null,
					stdout: stdout.value,
					stderr: stderr.value,
					durationMs: Math.round(performance.now() - startedAt),
					timedOut: true,
					outputTruncated: stdout.truncated || stderr.truncated,
				}
			}
			throw error
		}
	}
}
