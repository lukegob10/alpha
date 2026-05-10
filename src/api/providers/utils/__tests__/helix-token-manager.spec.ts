const { mockExec } = vi.hoisted(() => ({
	mockExec: vi.fn(),
}))

vi.mock("node:child_process", () => ({
	exec: mockExec,
}))

import { HelixTokenManager } from "../helix-token-manager"

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void

function queueExecSuccess(stdout: string) {
	mockExec.mockImplementationOnce(
		(
			_command: string,
			_options: { shell: boolean; windowsHide: boolean; timeout: number; maxBuffer: number },
			callback: ExecCallback,
		) => {
			callback(null, stdout, "")
			return {} as unknown
		},
	)
}

function queueExecFailure() {
	mockExec.mockImplementationOnce(
		(
			_command: string,
			_options: { shell: boolean; windowsHide: boolean; timeout: number; maxBuffer: number },
			callback: ExecCallback,
		) => {
			callback(new Error("command failed"), "", "")
			return {} as unknown
		},
	)
}

function uniqueCommand(label: string): string {
	return `helix-${label}-${Date.now()}-${Math.random()}`
}

describe("HelixTokenManager", () => {
	beforeEach(() => {
		mockExec.mockReset()
	})

	it("parses token from raw stdout", async () => {
		queueExecSuccess("token-raw-12345678901234567890\n")
		const manager = HelixTokenManager.getOrCreate({
			helixCommand: uniqueCommand("raw"),
			helixParseMode: "raw_stdout",
		})

		await expect(manager.getToken()).resolves.toBe("token-raw-12345678901234567890")
		expect(mockExec).toHaveBeenCalledTimes(1)
	})

	it("parses token from JSON field", async () => {
		queueExecSuccess(JSON.stringify({ credentials: { access_token: "token-json-12345678901234567890" } }))
		const manager = HelixTokenManager.getOrCreate({
			helixCommand: uniqueCommand("json"),
			helixParseMode: "json_field",
			helixTokenKey: "credentials.access_token",
		})

		await expect(manager.getToken()).resolves.toBe("token-json-12345678901234567890")
		expect(mockExec).toHaveBeenCalledTimes(1)
	})

	it("extracts token from noisy raw stdout with bearer prefix", async () => {
		queueExecSuccess(
			[
				"There is a newer version of Helix CLI available (v1.1.0), would you like to upgrade?",
				"Bearer ya29.a0ARrdaM-example-token-1234567890",
			].join("\n"),
		)

		const manager = HelixTokenManager.getOrCreate({
			helixCommand: uniqueCommand("raw-noisy-bearer"),
			helixParseMode: "raw_stdout",
		})

		await expect(manager.getToken()).resolves.toBe("ya29.a0ARrdaM-example-token-1234567890")
	})

	it("normalizes bearer prefix in JSON field tokens", async () => {
		queueExecSuccess(JSON.stringify({ access_token: "Bearer ya29.a0ARrdaM-json-token-1234567890" }))
		const manager = HelixTokenManager.getOrCreate({
			helixCommand: uniqueCommand("json-bearer"),
			helixParseMode: "json_field",
			helixTokenKey: "access_token",
		})

		await expect(manager.getToken()).resolves.toBe("ya29.a0ARrdaM-json-token-1234567890")
	})

	it("caches tokens between calls", async () => {
		queueExecSuccess("cached-token-12345678901234567890")
		const manager = HelixTokenManager.getOrCreate({
			helixCommand: uniqueCommand("cached"),
		})

		await expect(manager.getToken()).resolves.toBe("cached-token-12345678901234567890")
		await expect(manager.getToken()).resolves.toBe("cached-token-12345678901234567890")

		expect(mockExec).toHaveBeenCalledTimes(1)
	})

	it("forces refresh and replaces cached token", async () => {
		queueExecSuccess("initial-token-12345678901234567890")
		queueExecSuccess("refreshed-token-12345678901234567890")
		const manager = HelixTokenManager.getOrCreate({
			helixCommand: uniqueCommand("refresh"),
		})

		await expect(manager.getToken()).resolves.toBe("initial-token-12345678901234567890")
		await expect(manager.forceRefreshToken()).resolves.toBe("refreshed-token-12345678901234567890")

		expect(mockExec).toHaveBeenCalledTimes(2)
	})

	it("throws when configured JSON token field is missing", async () => {
		queueExecSuccess(JSON.stringify({ access_token: "token" }))
		const manager = HelixTokenManager.getOrCreate({
			helixCommand: uniqueCommand("missing-field"),
			helixParseMode: "json_field",
			helixTokenKey: "nested.token",
		})

		await expect(manager.getToken()).rejects.toThrow("configured token field")
	})

	it("throws when raw stdout token contains invalid whitespace", async () => {
		queueExecSuccess("this is not a token")
		const manager = HelixTokenManager.getOrCreate({
			helixCommand: uniqueCommand("raw-invalid-whitespace"),
			helixParseMode: "raw_stdout",
		})

		await expect(manager.getToken()).rejects.toThrow("whitespace")
	})

	it("throws when helix command execution fails", async () => {
		queueExecFailure()
		const manager = HelixTokenManager.getOrCreate({
			helixCommand: uniqueCommand("command-failure"),
		})

		await expect(manager.getToken()).rejects.toThrow("Helix command failed")
	})
})
