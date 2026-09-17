import { desc, eq, inArray, sql } from "drizzle-orm"

import type { ToolUsage } from "@alpha-code/types"

import { RecordNotFoundError, RecordNotCreatedError } from "./errors"
import type { InsertRun, UpdateRun } from "../schema"
import { schema } from "../schema"
import { client as db } from "../db"
import { createTaskMetrics } from "./taskMetrics"
import { getTasks } from "./tasks"

export const findRun = async (id: number) => {
	const run = await db.query.runs.findFirst({ where: eq(schema.runs.id, id) })

	if (!run) {
		throw new RecordNotFoundError()
	}

	return run
}

export const createRun = async (args: InsertRun) => {
	const records = await db
		.insert(schema.runs)
		.values({
			...args,
			createdAt: new Date(),
		})
		.returning()

	const record = records[0]

	if (!record) {
		throw new RecordNotCreatedError()
	}

	return record
}

export const updateRun = async (id: number, values: UpdateRun) => {
	const records = await db.update(schema.runs).set(values).where(eq(schema.runs.id, id)).returning()
	const record = records[0]

	if (!record) {
		throw new RecordNotFoundError()
	}

	return record
}

export const getRuns = async () =>
	db.query.runs.findMany({ orderBy: desc(schema.runs.id), with: { taskMetrics: true } })

export const finishRun = async (runId: number) => {
	const [values] = await db
		.select({
			tokensIn: sql<number>`coalesce(sum(${schema.taskMetrics.tokensIn}), 0)`.mapWith(Number),
			tokensOut: sql<number>`coalesce(sum(${schema.taskMetrics.tokensOut}), 0)`.mapWith(Number),
			tokensContext: sql<number>`coalesce(sum(${schema.taskMetrics.tokensContext}), 0)`.mapWith(Number),
			cacheWrites: sql<number>`coalesce(sum(${schema.taskMetrics.cacheWrites}), 0)`.mapWith(Number),
			cacheReads: sql<number>`coalesce(sum(${schema.taskMetrics.cacheReads}), 0)`.mapWith(Number),
			cost: sql<number>`coalesce(sum(${schema.taskMetrics.cost}), 0)`.mapWith(Number),
			duration: sql<number>`coalesce(sum(${schema.taskMetrics.duration}), 0)`.mapWith(Number),
			passed: sql<number>`coalesce(sum(CASE WHEN ${schema.tasks.passed} IS TRUE THEN 1 ELSE 0 END), 0)`.mapWith(
				Number,
			),
			failed: sql<number>`coalesce(sum(CASE WHEN ${schema.tasks.passed} IS FALSE THEN 1 ELSE 0 END), 0)`.mapWith(
				Number,
			),
		})
		.from(schema.tasks)
		.leftJoin(schema.taskMetrics, eq(schema.taskMetrics.id, schema.tasks.taskMetricsId))
		.where(eq(schema.tasks.runId, runId))

	if (!values) {
		throw new RecordNotFoundError()
	}

	const tasks = await getTasks(runId)

	const toolUsage = tasks.reduce((acc, task) => {
		Object.entries(task.taskMetrics?.toolUsage || {}).forEach(([key, { attempts, failures }]) => {
			const tool = key as keyof ToolUsage
			acc[tool] ??= { attempts: 0, failures: 0 }
			acc[tool].attempts += attempts
			acc[tool].failures += failures
		})

		return acc
	}, {} as ToolUsage)
	const requestUsage = tasks.flatMap((task) => task.taskMetrics?.requestUsage ?? [])

	const { passed, failed, ...rest } = values
	const taskMetrics = await createTaskMetrics({ ...rest, toolUsage, requestUsage })
	await updateRun(runId, { taskMetricsId: taskMetrics.id, passed, failed })

	const run = await findRun(runId)

	if (!run) {
		throw new RecordNotFoundError()
	}

	return { ...run, taskMetrics }
}

export const deleteRun = async (runId: number) => {
	const run = await db.query.runs.findFirst({
		where: eq(schema.runs.id, runId),
		columns: { taskMetricsId: true },
	})

	if (!run) {
		throw new RecordNotFoundError()
	}

	const tasks = await db.query.tasks.findMany({
		where: eq(schema.tasks.runId, runId),
		columns: { id: true, taskMetricsId: true },
	})

	await db.delete(schema.toolErrors).where(
		inArray(
			schema.toolErrors.taskId,
			tasks.map(({ id }) => id),
		),
	)

	await db.delete(schema.tasks).where(eq(schema.tasks.runId, runId))

	await db.delete(schema.toolErrors).where(eq(schema.toolErrors.runId, runId))
	await db.delete(schema.runs).where(eq(schema.runs.id, runId))

	const taskMetricsIds = tasks
		.map(({ taskMetricsId }) => taskMetricsId)
		.filter((id): id is number => id !== null && id !== undefined)

	taskMetricsIds.push(run.taskMetricsId ?? -1)

	await db.delete(schema.taskMetrics).where(inArray(schema.taskMetrics.id, taskMetricsIds))
}

/**
 * Get all runs without a taskMetricsId (incomplete runs)
 */
export const getIncompleteRuns = async () => {
	return db.query.runs.findMany({
		where: sql`${schema.runs.taskMetricsId} IS NULL`,
		columns: { id: true },
	})
}

/**
 * Delete multiple runs by their IDs
 */
export const deleteRunsByIds = async (runIds: number[]) => {
	if (runIds.length === 0) return

	// Get all tasks for these runs
	const tasks = await db.query.tasks.findMany({
		where: inArray(schema.tasks.runId, runIds),
		columns: { id: true, taskMetricsId: true },
	})

	const taskIds = tasks.map(({ id }) => id)

	// Get run taskMetricsIds
	const runs = await db.query.runs.findMany({
		where: inArray(schema.runs.id, runIds),
		columns: { taskMetricsId: true },
	})

	// Delete tool errors for tasks
	if (taskIds.length > 0) {
		await db.delete(schema.toolErrors).where(inArray(schema.toolErrors.taskId, taskIds))
	}

	// Delete tasks
	await db.delete(schema.tasks).where(inArray(schema.tasks.runId, runIds))

	// Delete tool errors for runs
	await db.delete(schema.toolErrors).where(inArray(schema.toolErrors.runId, runIds))

	// Delete from tables that exist in DB but not in drizzle schema
	// Using individual deletes since drizzle's sql template doesn't support custom table schemas
	for (const runId of runIds) {
		await db.execute(sql`DELETE FROM "cpuMetrics" WHERE run_id = ${runId}`)
		await db.execute(sql`DELETE FROM "notes" WHERE run_id = ${runId}`)
	}

	// Delete runs
	await db.delete(schema.runs).where(inArray(schema.runs.id, runIds))

	// Delete task metrics
	const taskMetricsIds = [
		...tasks
			.map(({ taskMetricsId }) => taskMetricsId)
			.filter((id): id is number => id !== null && id !== undefined),
		...runs.map(({ taskMetricsId }) => taskMetricsId).filter((id): id is number => id !== null && id !== undefined),
	]

	if (taskMetricsIds.length > 0) {
		await db.delete(schema.taskMetrics).where(inArray(schema.taskMetrics.id, taskMetricsIds))
	}
}
