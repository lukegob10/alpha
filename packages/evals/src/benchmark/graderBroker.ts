import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"

import { validateGraderRun, type GraderRunResult, type EvalTraceEvent } from "../grading/index"
import { REQUIRED_ARTIFACT_KINDS, type ArtifactDescriptor } from "../evidence/index"

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
	| {
			schemaVersion: 1
			requestId: string
			ok: true
			result: { run: GraderRunResult; artifacts: ArtifactDescriptor[] }
	  }
	| { schemaVersion: 1; requestId: string; ok: false; error: string }

const requestSchema = z.object({
	schemaVersion: z.literal(1),
	requestId: z.string().uuid(),
	attemptId: z.number().int().positive(),
	workspaceRoot: z.string().min(1),
	changedPaths: z.array(z.string()),
	trace: z.array(
		z.object({
			sequence: z.number().int().nonnegative(),
			type: z.string().min(1),
			timestamp: z.string().datetime({ offset: true }),
			payload: z.unknown().optional(),
		}),
	),
	usage: z.unknown().optional(),
	environment: z.record(z.unknown()),
})
const artifactSchema: z.ZodType<ArtifactDescriptor> = z.object({
	schemaVersion: z.literal(1),
	id: z.string().min(1),
	attemptId: z.string().min(1),
	kind: z.enum([...REQUIRED_ARTIFACT_KINDS, "full_output", "grader_evidence", "other"]),
	digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	mediaType: z.string().min(1),
	sizeBytes: z.number().int().nonnegative(),
	access: z.enum(["private", "reviewer", "public"]),
	retention: z.enum(["campaign", "baseline", "permanent"]),
	uploadState: z.literal("complete"),
	createdAt: z.string().datetime({ offset: true }),
})
const responseSchema = z.discriminatedUnion("ok", [
	z.object({
		schemaVersion: z.literal(1),
		requestId: z.string().uuid(),
		ok: z.literal(true),
		result: z.object({ run: z.unknown(), artifacts: z.array(artifactSchema) }),
	}),
	z.object({
		schemaVersion: z.literal(1),
		requestId: z.string().uuid(),
		ok: z.literal(false),
		error: z.string().min(1),
	}),
])

export async function submitGraderRequest(
	root: string,
	request: GraderBrokerRequest,
	timeoutMs: number,
): Promise<{ run: GraderRunResult; artifacts: ArtifactDescriptor[] }> {
	await fs.mkdir(root, { recursive: true })
	const requestPath = path.join(root, "request.json")
	const responsePath = path.join(root, "response.json")
	const boundRequest = requestSchema.parse({ ...request, requestId: randomUUID() })
	await fs.writeFile(`${requestPath}.partial`, JSON.stringify(boundRequest))
	await fs.rename(`${requestPath}.partial`, requestPath)
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			const parsed = responseSchema.safeParse(await readEnvelope(responsePath))
			if (!parsed.success) throw new Error("Invalid trusted grader receipt")
			const response = parsed.data
			if (response.requestId !== boundRequest.requestId)
				throw new Error("Trusted grader receipt belongs to another request")
			if (!response.ok) throw new Error(response.error)
			if (response.result.artifacts.some(({ attemptId }) => attemptId !== String(request.attemptId)))
				throw new Error("Trusted grader artifact belongs to another attempt")
			return { run: validateGraderRun(response.result.run), artifacts: response.result.artifacts }
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
	expectedAttemptId?: number
	execute(request: GraderBrokerRequest): Promise<{ run: GraderRunResult; artifacts: ArtifactDescriptor[] }>
}): Promise<void> {
	const requestPath = path.join(options.root, "request.json")
	const responsePath = path.join(options.root, "response.json")
	const deadline = Date.now() + options.timeoutMs
	while (!options.signal.aborted && Date.now() < deadline) {
		try {
			const parsed = requestSchema.safeParse(await readEnvelope(requestPath))
			if (!parsed.success) throw new Error("Invalid trusted grader request")
			const request = parsed.data
			let response: GraderBrokerResponse
			try {
				if (options.expectedAttemptId !== undefined && request.attemptId !== options.expectedAttemptId) {
					throw new Error("Trusted grader request belongs to another attempt")
				}
				response = {
					schemaVersion: 1,
					requestId: request.requestId,
					ok: true,
					result: await options.execute(request),
				}
			} catch (error) {
				response = {
					schemaVersion: 1,
					requestId: request.requestId,
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

async function readEnvelope(file: string): Promise<unknown> {
	const metadata = await fs.lstat(file)
	if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024)
		throw new Error("Invalid or oversized trusted grader envelope")
	const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
	try {
		// Allocate at most the declared size plus one byte to detect growth without an unbounded readFile.
		const buffer = Buffer.alloc(metadata.size + 1)
		let received = 0
		while (received < buffer.length) {
			const { bytesRead } = await handle.read(buffer, received, buffer.length - received, null)
			if (bytesRead === 0) break
			received += bytesRead
		}
		if (received !== metadata.size) throw new Error("Trusted grader envelope changed while reading")
		try {
			return JSON.parse(buffer.subarray(0, received).toString("utf8"))
		} catch {
			throw new Error("Invalid trusted grader JSON envelope")
		}
	} finally {
		await handle.close()
	}
}
