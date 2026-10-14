import { agentControlStateSchema } from "@alpha-code/types"

import { FileAgentControlPersistence } from "../../AgentControlStore"

const persistence = new FileAgentControlPersistence(process.argv[2])
const released = new Promise<void>((resolve) => {
	process.once("message", (message) => {
		if (message !== "release") throw new Error("Unexpected writer barrier message")
		resolve()
	})
})

async function writeUpdates() {
	for (let update = 0; update < 3; update++) {
		await persistence.withTransaction(async () => {
			const state = agentControlStateSchema.parse(await persistence.read())
			if (update === 0) {
				process.send?.("holding")
				await released
			}
			state.nextSequence++
			await persistence.write(state)
		})
	}
	process.disconnect()
}

writeUpdates().catch((error: unknown) => {
	console.error(error)
	process.exit(1)
})
