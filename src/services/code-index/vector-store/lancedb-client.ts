import * as fs from "fs/promises"
import * as path from "path"
import * as lancedb from "@lancedb/lancedb"
import type { Connection, Table } from "@lancedb/lancedb"

import { t } from "../../../i18n"
import { DEFAULT_LOCAL_INDEX_PATH, DEFAULT_MAX_SEARCH_RESULTS, DEFAULT_SEARCH_MIN_SCORE } from "../constants"
import { IVectorStore, Payload, PointStruct, VectorStoreSearchResult } from "../interfaces"

const TABLE_NAME = "code_blocks"
const METADATA_ID = "__indexing_metadata__"
const CODE_TYPE = "code"
const METADATA_TYPE = "metadata"

type LanceDbRecord = {
	id: string
	type: string
	filePath: string
	codeChunk: string
	startLine: number
	endLine: number
	segmentHash: string
	vectorSize: number
	indexingComplete: boolean
	startedAt: number
	completedAt: number
	vector: number[]
}

export class LanceDbVectorStore implements IVectorStore {
	private db?: Connection
	private table?: Table
	private readonly dbPath: string

	constructor(
		private readonly workspacePath: string,
		localIndexPath: string | undefined,
		private readonly vectorSize: number,
	) {
		this.dbPath = path.isAbsolute(localIndexPath || "")
			? path.normalize(localIndexPath!)
			: path.join(workspacePath, localIndexPath || DEFAULT_LOCAL_INDEX_PATH)
	}

	private async getDb(): Promise<Connection> {
		if (!this.db) {
			await fs.mkdir(this.dbPath, { recursive: true })
			this.db = await lancedb.connect(this.dbPath)
		}

		return this.db
	}

	private async getTable(): Promise<Table | undefined> {
		if (this.table) {
			return this.table
		}

		const db = await this.getDb()
		if (!(await this.tableExists(db))) {
			return undefined
		}

		this.table = await db.openTable(TABLE_NAME)
		return this.table
	}

	private async tableExists(db = this.db): Promise<boolean> {
		if (!db) {
			db = await this.getDb()
		}

		return (await db.tableNames()).includes(TABLE_NAME)
	}

	private metadataRecord(indexingComplete: boolean): LanceDbRecord {
		const now = Date.now()

		return {
			id: METADATA_ID,
			type: METADATA_TYPE,
			filePath: "",
			codeChunk: "",
			startLine: 0,
			endLine: 0,
			segmentHash: "",
			vectorSize: this.vectorSize,
			indexingComplete,
			startedAt: indexingComplete ? 0 : now,
			completedAt: indexingComplete ? now : 0,
			vector: new Array(this.vectorSize).fill(0),
		}
	}

	private toRecord(point: PointStruct): LanceDbRecord {
		return {
			id: String(point.id),
			type: CODE_TYPE,
			filePath: this.normalizeStoredPath(String(point.payload.filePath ?? "")),
			codeChunk: String(point.payload.codeChunk ?? ""),
			startLine: Number(point.payload.startLine ?? 0),
			endLine: Number(point.payload.endLine ?? 0),
			segmentHash: String(point.payload.segmentHash ?? ""),
			vectorSize: this.vectorSize,
			indexingComplete: false,
			startedAt: 0,
			completedAt: 0,
			vector: point.vector,
		}
	}

	private normalizeStoredPath(filePath: string): string {
		const relativePath = path.isAbsolute(filePath) ? path.relative(this.workspacePath, filePath) : filePath
		return path.normalize(relativePath).replace(/\\/g, "/")
	}

	private escapeSqlString(value: string): string {
		return value.replace(/'/g, "''")
	}

	private distanceToScore(distance: unknown): number {
		if (typeof distance !== "number" || Number.isNaN(distance)) {
			return 0
		}

		return Math.max(0, Math.min(1, 1 - distance))
	}

	private async createFreshTable(): Promise<void> {
		const db = await this.getDb()
		if (await this.tableExists(db)) {
			await db.dropTable(TABLE_NAME)
		}

		this.table = await db.createTable(TABLE_NAME, [this.metadataRecord(false)], { mode: "overwrite" })
	}

	private async ensureVectorDimension(table: Table): Promise<boolean> {
		const metadataRows = await table.query().where(`type = '${METADATA_TYPE}'`).limit(1).toArray()
		const storedVectorSize = Number(metadataRows[0]?.vectorSize)

		if (storedVectorSize > 0) {
			return storedVectorSize === this.vectorSize
		}

		const rows = await table.query().limit(1).toArray()
		const vector = rows[0]?.vector
		return !Array.isArray(vector) || vector.length === this.vectorSize
	}

	async initialize(): Promise<boolean> {
		try {
			const table = await this.getTable()

			if (!table) {
				await this.createFreshTable()
				return true
			}

			if (!(await this.ensureVectorDimension(table))) {
				await this.createFreshTable()
				return true
			}

			this.table = table
			return false
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			console.error(`[LanceDbVectorStore] Failed to initialize local index at ${this.dbPath}:`, error)
			throw new Error(t("embeddings:vectorStore.lanceConnectionFailed", { indexPath: this.dbPath, errorMessage }))
		}
	}

	async upsertPoints(points: PointStruct[]): Promise<void> {
		if (points.length === 0) {
			return
		}

		const table = await this.getTable()
		if (!table) {
			throw new Error(t("embeddings:serviceFactory.localIndexPathMissing"))
		}

		await table
			.mergeInsert("id")
			.whenMatchedUpdateAll()
			.whenNotMatchedInsertAll()
			.execute(points.map((point) => this.toRecord(point)))
	}

	async search(
		queryVector: number[],
		directoryPrefix?: string,
		minScore?: number,
		maxResults?: number,
	): Promise<VectorStoreSearchResult[]> {
		const table = await this.getTable()
		if (!table) {
			return []
		}

		const filters = [`type = '${CODE_TYPE}'`]
		if (directoryPrefix) {
			const normalizedPrefix = directoryPrefix.replace(/\\/g, "/").replace(/^\.\//, "")
			if (normalizedPrefix && normalizedPrefix !== ".") {
				const escapedPrefix = this.escapeSqlString(path.posix.normalize(normalizedPrefix))
				filters.push(`(filePath = '${escapedPrefix}' OR filePath LIKE '${escapedPrefix}/%')`)
			}
		}

		const rows = await (table.search(queryVector) as any)
			.distanceType("cosine")
			.where(filters.join(" AND "))
			.limit(maxResults ?? DEFAULT_MAX_SEARCH_RESULTS)
			.toArray()

		const scoreThreshold = minScore ?? DEFAULT_SEARCH_MIN_SCORE

		return rows
			.map((row: any): VectorStoreSearchResult => {
				const score = this.distanceToScore(row._distance ?? row._score)
				const payload: Payload = {
					filePath: String(row.filePath ?? ""),
					codeChunk: String(row.codeChunk ?? ""),
					startLine: Number(row.startLine ?? 0),
					endLine: Number(row.endLine ?? 0),
					segmentHash: String(row.segmentHash ?? ""),
				}

				return {
					id: String(row.id),
					score,
					payload,
				}
			})
			.filter((result: VectorStoreSearchResult) => result.score >= scoreThreshold)
	}

	async deletePointsByFilePath(filePath: string): Promise<void> {
		await this.deletePointsByMultipleFilePaths([filePath])
	}

	async deletePointsByMultipleFilePaths(filePaths: string[]): Promise<void> {
		if (filePaths.length === 0) {
			return
		}

		const table = await this.getTable()
		if (!table) {
			return
		}

		const normalizedPaths = filePaths.map(
			(filePath) => `'${this.escapeSqlString(this.normalizeStoredPath(filePath))}'`,
		)
		await table.delete(`filePath IN (${normalizedPaths.join(", ")})`)
	}

	async clearCollection(): Promise<void> {
		await this.createFreshTable()
	}

	async deleteCollection(): Promise<void> {
		const db = await this.getDb()
		if (await this.tableExists(db)) {
			await db.dropTable(TABLE_NAME)
		}
		this.table = undefined
	}

	async collectionExists(): Promise<boolean> {
		return this.tableExists()
	}

	async hasIndexedData(): Promise<boolean> {
		const table = await this.getTable()
		if (!table) {
			return false
		}

		const codeRows = await table.countRows(`type = '${CODE_TYPE}'`)
		if (codeRows === 0) {
			return false
		}

		const metadataRows = await table.query().where(`id = '${METADATA_ID}'`).limit(1).toArray()
		if (metadataRows.length > 0) {
			return metadataRows[0]?.indexingComplete === true
		}

		return true
	}

	async markIndexingComplete(): Promise<void> {
		await this.upsertMetadata(true)
	}

	async markIndexingIncomplete(): Promise<void> {
		await this.upsertMetadata(false)
	}

	private async upsertMetadata(indexingComplete: boolean): Promise<void> {
		const table = await this.getTable()
		if (!table) {
			await this.createFreshTable()
			if (!indexingComplete) {
				return
			}
		}

		const currentTable = await this.getTable()
		if (!currentTable) {
			throw new Error(t("embeddings:serviceFactory.localIndexPathMissing"))
		}

		await currentTable
			.mergeInsert("id")
			.whenMatchedUpdateAll()
			.whenNotMatchedInsertAll()
			.execute([this.metadataRecord(indexingComplete)])
	}
}
