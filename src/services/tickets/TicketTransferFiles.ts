import * as fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"

/** File paths come only from native open/save dialogs, never webview messages. */
export async function readTicketTransferFile(
	file: string,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<Uint8Array> {
	signal?.throwIfAborted()
	const handle = await fs.open(file, "r")
	try {
		const before = await handle.stat()
		if (!before.isFile() || before.size > maxBytes) throw new Error("Ticket import file exceeds its size limit")
		const bytes = Buffer.alloc(before.size + 1)
		let length = 0
		while (length < bytes.length) {
			signal?.throwIfAborted()
			const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
			if (!bytesRead) break
			length += bytesRead
		}
		const after = await handle.stat()
		if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
			throw new Error("Ticket import file changed while reading; select it again")
		signal?.throwIfAborted()
		return bytes.subarray(0, length)
	} finally {
		await handle.close()
	}
}

/** A failed or cancelled export must not truncate a previously saved bundle. */
export async function writeTicketExport(file: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted()
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
	let ownsTemporary = false
	try {
		const handle = await fs.open(temporary, "wx", 0o600)
		ownsTemporary = true
		try {
			await handle.writeFile(bytes)
			await handle.sync()
		} finally {
			await handle.close()
		}
		signal?.throwIfAborted()
		await fs.rename(temporary, file)
	} finally {
		if (ownsTemporary) await fs.rm(temporary, { force: true })
	}
}
