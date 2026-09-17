import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as path from "path"

export function digestContent(value: string | Buffer): string {
	return crypto.createHash("sha256").update(value).digest("hex")
}

export async function writeAtomic(filePath: string, content: string | Buffer): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`
	await fs.writeFile(temporaryPath, content)
	await fs.rename(temporaryPath, filePath)
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export async function readJson<T>(filePath: string): Promise<T> {
	return JSON.parse(await fs.readFile(filePath, "utf8")) as T
}

export async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath)
		return true
	} catch {
		return false
	}
}
