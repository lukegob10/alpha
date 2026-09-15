import fs from "node:fs/promises"
import { createWriteStream } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { x as extract } from "tar"
import * as vscode from "vscode"
import { t } from "../../i18n"
import { renameWithRetry } from "../../core/task-persistence/atomicWrite"

export const SANDBOX_RUNTIME_VERSION = "0.144.6"
// Official release digests, pinned with the protocol adapter. See docs/command-sandbox.md.
export const SANDBOX_RELEASES: Readonly<Record<string, { target: string; sha256: string }>> = {
	"win32-x64": {
		target: "x86_64-pc-windows-msvc",
		sha256: "81948ef44eb00f499f32bcd38ce326f59f5a132ca4cd6ec2559fb5fc7cfd90a7",
	},
	"win32-arm64": {
		target: "aarch64-pc-windows-msvc",
		sha256: "0a2712488e331acbbe24792d264d4774d045b8a66212338e2963e266492a9205",
	},
	"darwin-x64": {
		target: "x86_64-apple-darwin",
		sha256: "daa3df37c8a041280f52a2198dbe7acbead64936b23f8b660edf9d886df5f9da",
	},
	"darwin-arm64": {
		target: "aarch64-apple-darwin",
		sha256: "bcbfa76650b6c581505aa5178c1e799d37ff12fc43a35ff16c90b97fa757e63f",
	},
	"linux-x64": {
		target: "x86_64-unknown-linux-musl",
		sha256: "99ae48e4743da6c530ecd998ab2f7e66572c092f4190c88dca8236c07b06ce1d",
	},
	"linux-arm64": {
		target: "aarch64-unknown-linux-musl",
		sha256: "b4359896bb548e02fdd72ea0cb3395fe8a88d20d3a4a421c4481e504f8e8927f",
	},
}

const installations = new Map<string, Promise<string>>()

export async function ensureSandboxRuntime(storage: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted()
	const existing = installations.get(storage)
	if (existing) return existing
	const installing = installRuntime(storage, signal)
	installations.set(storage, installing)
	try {
		return await installing
	} catch (error) {
		throw new Error(t("common:commandSandbox.unavailable"), { cause: error })
	} finally {
		if (installations.get(storage) === installing) installations.delete(storage)
	}
}

async function installRuntime(storage: string, signal?: AbortSignal): Promise<string> {
	const release = SANDBOX_RELEASES[`${process.platform}-${process.arch}`]
	if (!release) throw new Error(`Unsupported command sandbox platform: ${process.platform}-${process.arch}`)
	const parent = path.join(storage, "command-sandbox", "runtime")
	const destination = path.join(parent, `${SANDBOX_RUNTIME_VERSION}-${release.target}`)
	const executable = path.join(destination, "bin", process.platform === "win32" ? "codex.exe" : "codex")
	try {
		await fs.access(executable)
		return executable
	} catch {
		/* A missing runtime is installed once, on demand. */
	}
	await fs.mkdir(parent, { recursive: true })
	const staging = await fs.mkdtemp(path.join(parent, "install-"))
	const archive = path.join(staging, "runtime.tar.gz")
	const unpacked = path.join(staging, "package")
	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: t("common:commandSandbox.installing"),
				cancellable: true,
			},
			async (progress, token) => {
				const controller = new AbortController()
				const cancel = () => controller.abort()
				const subscription = token.onCancellationRequested(cancel)
				signal?.addEventListener("abort", cancel, { once: true })
				if (signal?.aborted) cancel()
				const timeout = setTimeout(cancel, 300_000)
				try {
					const response = await fetch(
						`https://github.com/openai/codex/releases/download/rust-v${SANDBOX_RUNTIME_VERSION}/codex-package-${release.target}.tar.gz`,
						{ signal: controller.signal },
					)
					if (!response.ok || !response.body) throw new Error(`Sandbox download failed (${response.status})`)
					const hash = createHash("sha256")
					let bytes = 0
					const limit = 200_000_000
					const meter = new Transform({
						transform(chunk, _encoding, callback) {
							bytes += chunk.length
							if (bytes > limit) return callback(new Error("Sandbox archive exceeds size limit"))
							hash.update(chunk)
							callback(null, chunk)
						},
					})
					await pipeline(
						Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
						meter,
						createWriteStream(archive, { flags: "wx" }),
						{ signal: controller.signal },
					)
					if (hash.digest("hex") !== release.sha256) throw new Error("Sandbox archive checksum mismatch")
					progress.report({ message: t("common:commandSandbox.preparing") })
					await fs.mkdir(unpacked)
					await extract({
						file: archive,
						cwd: unpacked,
						strict: true,
						filter: (name, entry) => {
							const parts = name.replace(/\\/g, "/").split("/")
							return (
								!path.isAbsolute(name) &&
								!parts.includes("..") &&
								"type" in entry &&
								["File", "Directory"].includes(entry.type)
							)
						},
					})
					controller.signal.throwIfAborted()
					await fs.access(path.join(unpacked, "bin", path.basename(executable)))
					try {
						// Windows scanners/watchers can briefly deny renaming newly extracted executables.
						// Reuse the bounded atomic-publication retry, without downloading again or widening access.
						await renameWithRetry(unpacked, destination, controller.signal)
					} catch (error) {
						// Another extension host may have finished the same immutable installation.
						try {
							await fs.access(executable)
						} catch {
							throw error
						}
					}
				} finally {
					clearTimeout(timeout)
					subscription.dispose()
					signal?.removeEventListener("abort", cancel)
				}
			},
		)
		return executable
	} finally {
		await fs.rm(staging, { recursive: true, force: true })
	}
}
