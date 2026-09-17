import fs from "node:fs/promises"
import path from "node:path"

import type { GraderRunResult, EvalTraceEvent } from "../grading/index"
import type { ArtifactDescriptor } from "../evidence/index"

export type GraderBrokerRequest = {
	schemaVersion: 1
	attemptId: number
	workspaceRoot: string
	changedPaths: string[]
	trace: EvalTraceEvent[]
	usage?: unknown
	environment: Record<string, unknown>
}

export type GraderBrokerResponse =
	| { schemaVersion: 1; ok: true; result: { run: GraderRunResult; artifacts: ArtifactDescriptor[] } }
	| { schemaVersion: 1; ok: false; error: string }

export async function submitGraderRequest(
	root: string,
	request: GraderBrokerRequest,
	timeoutMs: number,
): Promise<{ run: GraderRunResult; artifacts: ArtifactDescriptor[] }> {
	await fs.mkdir(root, { recursive: true })
	const requestPath = path.join(root, "request.json")
	const responsePath = path.join(root, "response.json")
	await fs.writeFile(`${requestPath}.partial`, JSON.stringify(request))
	await fs.rename(`${requestPath}.partial`, requestPath)
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			const response = JSON.parse(await fs.readFile(responsePath, "utf8")) as GraderBrokerResponse
			if (!response.ok) throw new Error(response.error)
			return response.result
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
	}
	throw new Error(`Trusted grader broker timed out after ${timeoutMs}ms`)
}

export async function serveGraderRequest(options: {
	root: string
	timeoutMs: number
	signal: AbortSignal
	execute(request: GraderBrokerRequest): Promise<{ run: GraderRunResult; artifacts: ArtifactDescriptor[] }>
}): Promise<void> {
	const requestPath = path.join(options.root, "request.json")
	const responsePath = path.join(options.root, "response.json")
	const deadline = Date.now() + options.timeoutMs
	while (!options.signal.aborted && Date.now() < deadline) {
		try {
			const request = JSON.parse(await fs.readFile(requestPath, "utf8")) as GraderBrokerRequest
			let response: GraderBrokerResponse
			try {
				response = { schemaVersion: 1, ok: true, result: await options.execute(request) }
			} catch (error) {
				response = {
					schemaVersion: 1,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				}
			}
			await fs.writeFile(`${responsePath}.partial`, JSON.stringify(response))
			await fs.rename(`${responsePath}.partial`, responsePath)
			return
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
	}
}
