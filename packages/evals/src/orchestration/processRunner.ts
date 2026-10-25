import { execa } from "execa"

import type { HarnessProcessResult, HarnessProcessRunner, HarnessProcessSpec } from "./ports"

export class ExecaHarnessProcessRunner implements HarnessProcessRunner {
	async run(spec: HarnessProcessSpec): Promise<HarnessProcessResult> {
		const startedAt = performance.now()
		const result = await execa(spec.command, spec.args, {
			cwd: spec.cwd,
			env: spec.env,
			extendEnv: spec.env === undefined,
			reject: false,
			timeout: spec.timeoutMs,
			killSignal: "SIGKILL",
			maxBuffer: Math.max(spec.maxOutputBytes * 64, 64 * 1024 * 1024),
			...(spec.signal ? { cancelSignal: spec.signal } : {}),
		})
		const stdout = capOutput(result.stdout ?? "", spec.maxOutputBytes)
		const stderr = capOutput(result.stderr ?? "", spec.maxOutputBytes)
		// Execa 9.6 can finish output collection unsuccessfully after the child has exited zero.
		// Such results cannot establish either a passing or failing verifier outcome.
		const incomplete =
			result.timedOut ||
			result.isMaxBuffer ||
			result.isCanceled ||
			result.isTerminated ||
			(result.failed && result.exitCode === 0)
		return {
			exitCode: incomplete ? null : (result.exitCode ?? null),
			stdout: stdout.value,
			stderr: stderr.value,
			durationMs: Math.round(performance.now() - startedAt),
			timedOut: result.timedOut,
			outputTruncated: Boolean(result.isMaxBuffer) || stdout.truncated || stderr.truncated,
			fullStdout: result.stdout ?? "",
			fullStderr: result.stderr ?? "",
		}
	}
}

function capOutput(value: string, maxBytes: number): { value: string; truncated: boolean } {
	const buffer = Buffer.from(value)
	if (buffer.byteLength <= maxBytes) return { value, truncated: false }
	return { value: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true }
}
