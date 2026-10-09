const fs = require("node:fs/promises")
const { randomUUID } = require("node:crypto")

async function writeReceipt(target, value, fileSystem = fs) {
	const temporary = `${target}.${randomUUID()}.tmp`
	try {
		await fileSystem.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 })
		// Publish complete bytes atomically without replacing another activation's receipt.
		await fileSystem.link(temporary, target)
	} finally {
		await fileSystem.unlink(temporary).catch((error) => {
			if (error?.code !== "ENOENT") throw error
		})
	}
}

exports.writeReceipt = writeReceipt
