import path from "path"
import { createHash } from "crypto"
import { v5 as uuidv5 } from "uuid"
import type { CodeBlock, PointStruct } from "../interfaces"
import type { CodeIndexConfig } from "../interfaces/config"
import { QDRANT_CODE_BLOCK_NAMESPACE } from "../constants"

import { getDefaultModelId } from "../../../shared/embeddingModels"

export const CODE_INDEX_VERSION = 2

/** Fingerprints representation and model identity, never credentials. */
export function getIndexIdentity(config: CodeIndexConfig): string {
	const vertex = config.vertexOptions
	const configuredRoutes = vertex?.modelRoutingMap ?? vertex?.vertexGatewayModelRoutingMap
	let routes: unknown = configuredRoutes
	if (typeof routes === "string") {
		try {
			routes = JSON.parse(routes)
		} catch {
			routes = undefined
		}
	}
	const modelRoutes =
		routes && typeof routes === "object"
			? Object.entries(routes)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([alias, target]) => [
						alias,
						typeof target === "string"
							? target
							: target && typeof target === "object" && "modelOverride" in target
								? target.modelOverride
								: undefined,
					])
			: undefined
	return createHash("sha256")
		.update(
			JSON.stringify({
				version: CODE_INDEX_VERSION,
				provider: config.embedderProvider,
				model: config.modelId ?? getDefaultModelId(config.embedderProvider),
				dimension: config.modelDimension,
				endpoint:
					config.openAiCompatibleOptions?.baseUrl ??
					config.ollamaOptions?.ollamaBaseUrl ??
					vertex?.gatewayBaseUrl ??
					vertex?.vertexGatewayBaseUrl,
				vertexModelRouting: modelRoutes,
			}),
		)
		.digest("hex")
}

export function getEmbeddingText(block: CodeBlock, workspacePath: string): string {
	const filePath = relativeIndexPath(block.file_path, workspacePath)
	return [`File: ${filePath}`, block.context || block.identifier || "", block.content].filter(Boolean).join("\n")
}

export function relativeIndexPath(filePath: string, workspacePath: string): string {
	const relative = path.isAbsolute(filePath) ? path.relative(workspacePath, filePath) : filePath
	const normalized = path.posix.normalize(relative.replace(/\\/g, "/"))
	if (
		normalized === ".." ||
		normalized.startsWith("../") ||
		path.posix.isAbsolute(normalized) ||
		/^[a-z]:/i.test(normalized)
	) {
		throw new Error("Code index path is outside the workspace")
	}
	return normalized
}

export function createIndexPoint(block: CodeBlock, workspacePath: string, vector: number[]): PointStruct {
	const filePath = relativeIndexPath(block.file_path, workspacePath)
	return {
		id: uuidv5(
			`${filePath}\0${block.startOffset ?? block.start_line}\0${block.segmentHash}`,
			QDRANT_CODE_BLOCK_NAMESPACE,
		),
		vector,
		payload: {
			filePath,
			codeChunk: block.content,
			startLine: block.start_line,
			endLine: block.end_line,
			startOffset: block.startOffset ?? -1,
			endOffset: block.endOffset ?? -1,
			segmentHash: block.segmentHash,
			fileHash: block.fileHash,
			context: block.context ?? "",
			identifier: block.identifier ?? "",
			chunkType: block.type,
			tokenCount: block.tokenCount ?? 0,
		},
	}
}

export function validateEmbeddingBatch(embeddings: number[][], count: number): void {
	const dimension = embeddings[0]?.length
	if (
		embeddings.length !== count ||
		!dimension ||
		embeddings.some((vector) => vector.length !== dimension || vector.some((value) => !Number.isFinite(value)))
	) {
		throw new Error("Embedding provider returned an incomplete or invalid batch")
	}
}
