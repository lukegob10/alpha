import { agentControlStateSchema } from "@alpha-code/types"

import { FileAgentControlPersistence } from "../../AgentControlStore"

async function run() {
	const persistence = new FileAgentControlPersistence(process.argv[2])
	for (let update = 0; update < 32; update++) {
		await persistence.withTransaction(async () => {
			const state = agentControlStateSchema.parse(await persistence.read())
			if (update === 0) {
				const release = new Promise<void>((resolve, reject) => {
					process.once("message", (message) => {
						if (message !== "release") reject(new Error("Unexpected writer release"))
						else resolve()
					})
				})
				process.send?.("holding")
				await release
			}
			process.send?.(`acquired:${update}`)
			state.nextSequence++
			await persistence.write(state)
		})
	}
	process.send?.("finished")
	process.disconnect()
}

run().catch((error: unknown) => {
	console.error(error)
	process.exit(1)
})
