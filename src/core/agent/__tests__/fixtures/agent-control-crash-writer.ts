import * as fs from "fs/promises"

import { agentControlStateSchema } from "@alpha-code/types"

import { FileAgentControlPersistence } from "../../AgentControlStore"

const persistence = new FileAgentControlPersistence(process.argv[2])
const phase = process.argv[3]
const stopped = new Promise<void>(() => undefined)
const pause = async () => {
	process.send?.("ready")
	await stopped
}
const internals = persistence as unknown as {
	tryCreateTransactionLock(owner: { token: string; pid: number }, signal?: AbortSignal): Promise<boolean>
	removeReleasedTransactionLockDirectory(...args: unknown[]): Promise<void>
}

if (phase === "preparing") {
	internals.tryCreateTransactionLock = async (owner) => {
		// Stop at the unpublished candidate boundary with interrupted metadata.
		await fs.writeFile(`${persistence.filePath}.transaction.lock.candidate.${owner.token}`, '{"token":')
		await pause()
		return false
	}
} else if (phase === "published") {
	const publish = internals.tryCreateTransactionLock.bind(persistence)
	internals.tryCreateTransactionLock = async (...args) => {
		const acquired = await publish(...args)
		if (acquired) await pause()
		return acquired
	}
} else if (phase === "released") {
	internals.removeReleasedTransactionLockDirectory = pause
}

persistence
	.withTransaction(async () => {
		const state = agentControlStateSchema.parse(await persistence.read())
		state.nextSequence++
		await persistence.write(state)
		if (phase === "committed") await pause()
	})
	.catch((error: unknown) => {
		console.error(error)
		process.exit(1)
	})
