import fs from "node:fs/promises"
import path from "node:path"

import { updateCalibrationReport } from "../../calibrationStore"
import { mergeModelCalibration, type ModelCalibrationTrial } from "../../modelCalibration"

export type CalibrationStoreProcessUpdate = {
	op: "update"
	id: number
	model: "luna-high" | "sol-high"
	prefix: string
	expectedRevision?: string | null
	lockTimeoutMs?: number
	holdPublication?: boolean
}

export type CalibrationStoreProcessMessage =
	| { type: "ready" }
	| { type: "held" | "contended"; id: number }
	| {
			type: "result"
			id: number
			ok: true
			callbackCount: number
			revision: string | null
	  }
	| {
			type: "result"
			id: number
			ok: false
			callbackCount: number
			code?: string
			reason?: string
			message: string
	  }

const file = process.argv[2]
if (!file) throw new Error("A calibration report fixture path is required")
const target = path.join(await fs.realpath(path.dirname(file)), path.basename(file))
const lock = `${target}.calibration.lock`
const originalOpen = fs.open.bind(fs)
const originalRename = fs.rename.bind(fs)
let active: CalibrationStoreProcessUpdate | undefined
let releasePublication: (() => void) | undefined
let reportedContention = false

const send = (message: CalibrationStoreProcessMessage) => process.send?.(message)

// The barriers pause real filesystem boundaries without replacing the store's locking or publication behavior.
fs.open = async (file, flags, mode) => {
	try {
		return await originalOpen(file, flags, mode)
	} catch (error) {
		if (
			active &&
			!reportedContention &&
			String(file) === lock &&
			(error as NodeJS.ErrnoException).code === "EEXIST"
		) {
			reportedContention = true
			send({ type: "contended", id: active.id })
		}
		throw error
	}
}

fs.rename = async (source, destination) => {
	if (active?.holdPublication && String(destination) === target) {
		const request = active
		await new Promise<void>((resolve) => {
			releasePublication = resolve
			send({ type: "held", id: request.id })
		})
		releasePublication = undefined
	}
	await originalRename(source, destination)
}

async function update(request: CalibrationStoreProcessUpdate): Promise<void> {
	if (active) throw new Error("The calibration fixture accepts one update at a time")
	active = request
	reportedContention = false
	let callbackCount = 0
	try {
		const result = await updateCalibrationReport(
			target,
			(current) => {
				callbackCount++
				if (!current) throw new Error("The calibration fixture requires an existing report")
				const trials: ModelCalibrationTrial[] = Array.from({ length: 5 }, (_, index) => ({
					id: `${request.prefix}-${index}`,
					taskIdentity: current.taskIdentity,
					model: request.model,
					passed: true,
					unexpected: false,
					safetyFailed: false,
					reviewed: false,
				}))
				return mergeModelCalibration(current, trials)
			},
			{
				...(Object.hasOwn(request, "expectedRevision") ? { expectedRevision: request.expectedRevision } : {}),
				...(request.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: request.lockTimeoutMs }),
			},
		)
		send({ type: "result", id: request.id, ok: true, callbackCount, revision: result.revision })
	} catch (error) {
		const details = error as { code?: unknown; reason?: unknown }
		send({
			type: "result",
			id: request.id,
			ok: false,
			callbackCount,
			...(typeof details.code === "string" ? { code: details.code } : {}),
			...(typeof details.reason === "string" ? { reason: details.reason } : {}),
			message: error instanceof Error ? error.message : String(error),
		})
	} finally {
		active = undefined
	}
}

process.on("message", (message: unknown) => {
	if (typeof message !== "object" || message === null || !("op" in message)) return
	if (message.op === "release") {
		releasePublication?.()
		return
	}
	if (message.op === "update") {
		void update(message as CalibrationStoreProcessUpdate).catch((error: unknown) => {
			console.error(error)
			process.exitCode = 1
			process.disconnect()
		})
	}
})
process.on("disconnect", () => process.exit())
send({ type: "ready" })
