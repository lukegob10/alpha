import { execFile } from "child_process"
import * as vscode from "vscode"

import { GitHubApiClient, getGitHubProxyConfig } from "../GitHubApiClient"

vi.mock("child_process", () => ({
	execFile: vi.fn(),
}))

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(),
	},
}))

describe("GitHubApiClient proxy configuration", () => {
	const originalEnv = {
		HTTPS_PROXY: process.env.HTTPS_PROXY,
		https_proxy: process.env.https_proxy,
		HTTP_PROXY: process.env.HTTP_PROXY,
		http_proxy: process.env.http_proxy,
		NO_PROXY: process.env.NO_PROXY,
		no_proxy: process.env.no_proxy,
	}

	beforeEach(() => {
		vi.clearAllMocks()
		delete process.env.HTTPS_PROXY
		delete process.env.https_proxy
		delete process.env.HTTP_PROXY
		delete process.env.http_proxy
		delete process.env.NO_PROXY
		delete process.env.no_proxy
		mockHttpConfiguration({})
	})

	afterEach(() => {
		restoreEnv("HTTPS_PROXY", originalEnv.HTTPS_PROXY)
		restoreEnv("https_proxy", originalEnv.https_proxy)
		restoreEnv("HTTP_PROXY", originalEnv.HTTP_PROXY)
		restoreEnv("http_proxy", originalEnv.http_proxy)
		restoreEnv("NO_PROXY", originalEnv.NO_PROXY)
		restoreEnv("no_proxy", originalEnv.no_proxy)
	})

	it("uses VS Code http.proxy with proxy auth and strict SSL settings", () => {
		mockHttpConfiguration({
			proxy: " http://proxy.example.com:8080 ",
			proxyAuthorization: "Basic token",
			proxyStrictSSL: false,
		})

		expect(getGitHubProxyConfig("https://api.github.com/repos/owner/repo")).toEqual({
			proxyUrl: "http://proxy.example.com:8080",
			proxyAuthorization: "Basic token",
			strictSSL: false,
			source: "vscode",
			useProxyNegotiate: true,
		})
	})

	it("does not use a proxy when VS Code proxy support is off", () => {
		process.env.HTTPS_PROXY = "http://env-proxy.example.com:8080"
		mockHttpConfiguration({
			proxy: "http://proxy.example.com:8080",
			proxySupport: "off",
		})

		expect(getGitHubProxyConfig("https://api.github.com/repos/owner/repo")).toEqual({
			strictSSL: true,
			source: "none",
			useProxyNegotiate: false,
		})
	})

	it("honors VS Code http.noProxy entries", () => {
		mockHttpConfiguration({
			proxy: "http://proxy.example.com:8080",
			noProxy: ["*.github.com"],
		})

		expect(getGitHubProxyConfig("https://api.github.com/repos/owner/repo")).toEqual({
			strictSSL: true,
			source: "none",
			useProxyNegotiate: false,
		})
	})

	it("falls back to environment proxy settings", () => {
		process.env.HTTPS_PROXY = "http://env-proxy.example.com:8080"

		expect(getGitHubProxyConfig("https://api.github.com/repos/owner/repo")).toEqual({
			proxyUrl: "http://env-proxy.example.com:8080",
			strictSSL: true,
			source: "environment",
			useProxyNegotiate: false,
		})
	})

	it("honors environment no_proxy entries", () => {
		process.env.HTTPS_PROXY = "http://env-proxy.example.com:8080"
		process.env.NO_PROXY = "api.github.com"

		expect(getGitHubProxyConfig("https://api.github.com/repos/owner/repo")).toEqual({
			strictSSL: true,
			source: "none",
			useProxyNegotiate: false,
		})
	})

	it("uses curl with negotiate authentication for VS Code proxy requests", async () => {
		mockHttpConfiguration({
			proxy: "http://proxy.example.com:8080",
		})
		vi.mocked(execFile).mockImplementation((_command, _args, _options, callback) => {
			callback?.(
				null,
				JSON.stringify({ html_url: "https://github.com/owner/repo/pull/1", number: 1 }) +
					"\n__ALPHA_GITHUB_HTTP_STATUS__:200",
				"",
			)
			return undefined as any
		})

		await new GitHubApiClient("test-token").getPullRequest({ owner: "owner", repo: "repo", pull_number: 1 })

		const [command, args] = vi.mocked(execFile).mock.calls[0]
		expect(command).toBe("curl")
		expect(args).toEqual(
			expect.arrayContaining([
				"--proxy",
				"http://proxy.example.com:8080",
				"--proxy-user",
				":",
				"--proxy-negotiate",
				"--header",
				"Authorization: Bearer test-token",
			]),
		)
	})

	it("does not expose authorization values when curl fails", async () => {
		const githubToken = "github-secret"
		const proxyAuthorization = "Basic proxy-secret"
		mockHttpConfiguration({
			proxy: "http://proxy.example.com:8080",
			proxyAuthorization,
		})
		vi.mocked(execFile).mockImplementation((_command, _args, _options, callback) => {
			const error = Object.assign(
				new Error(
					`Command failed: curl --header Authorization: Bearer ${githubToken} --proxy-header ${proxyAuthorization}`,
				),
				{ code: 7 },
			)
			callback?.(error, "", "curl: (7) Failed to connect")
			return undefined as any
		})

		let thrown: unknown
		try {
			await new GitHubApiClient(githubToken).getPullRequest({ owner: "owner", repo: "repo", pull_number: 1 })
		} catch (error) {
			thrown = error
		}

		const message = thrown instanceof Error ? thrown.message : String(thrown)
		expect(message).toContain("curl: (7) Failed to connect")
		expect(message).not.toContain(githubToken)
		expect(message).not.toContain("proxy-secret")
	})
})

function mockHttpConfiguration(values: Record<string, unknown>) {
	vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
		get: vi.fn((key: string, defaultValue?: unknown) => (key in values ? values[key] : defaultValue)),
	} as any)
}

function restoreEnv(key: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[key]
	} else {
		process.env[key] = value
	}
}

describe("GitHub request cancellation and deadlines", () => {
	const fetchMock = vi.fn<typeof fetch>()
	const comment = { owner: "owner", repo: "repo", issue_number: 1, body: "body" }

	beforeEach(() => {
		vi.useFakeTimers()
		fetchMock.mockReset()
		vi.stubGlobal("fetch", fetchMock)
		vi.mocked(execFile).mockReset()
		mockHttpConfiguration({ proxySupport: "off" })
	})

	afterEach(() => {
		expect(vi.getTimerCount()).toBe(0)
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	function waitForAbort(signal: AbortSignal) {
		return new Promise<never>((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(new Error("aborted transport")), { once: true })
		})
	}

	it("does not dispatch an already-cancelled request", async () => {
		const controller = new AbortController()
		controller.abort()
		await expect(
			new GitHubApiClient("token", { signal: controller.signal }).comment(comment),
		).rejects.toMatchObject({ reason: "cancelled", outcomeUnknown: false })
		expect(fetchMock).not.toHaveBeenCalled()
		expect(execFile).not.toHaveBeenCalled()
	})

	it("cancels fetch and reports an uncertain write outcome without leaking abort reasons", async () => {
		const controller = new AbortController()
		const removeListener = vi.spyOn(controller.signal, "removeEventListener")
		fetchMock.mockImplementation((_url, options) => waitForAbort(options!.signal!))
		const request = new GitHubApiClient("token", { signal: controller.signal }).comment(comment)
		const rejected = expect(request).rejects.toMatchObject({
			reason: "cancelled",
			outcomeUnknown: true,
			message: expect.stringContaining("check its state before retrying"),
		})
		controller.abort(new Error("sensitive abort reason"))
		await rejected
		expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function))
	})

	it("keeps the deadline active while reading the response body", async () => {
		let bodyStarted!: () => void
		const started = new Promise<void>((resolve) => {
			bodyStarted = resolve
		})
		fetchMock.mockImplementation(async (_url, options) => {
			const response = new Response()
			vi.spyOn(response, "json").mockImplementation(() => {
				bodyStarted()
				return waitForAbort(options!.signal!)
			})
			return response
		})
		const request = new GitHubApiClient("token", { timeoutMs: 100 }).getPullRequest({
			owner: "owner",
			repo: "repo",
			pull_number: 1,
		})
		const rejected = expect(request).rejects.toMatchObject({ reason: "timeout", outcomeUnknown: false })
		await started
		await vi.advanceTimersByTimeAsync(100)
		await rejected
	})

	it.each(["cancelled", "timeout"] as const)("stops the proxy curl process on %s", async (reason) => {
		mockHttpConfiguration({ proxy: "http://proxy.example.com:8080" })
		const controller = new AbortController()
		vi.mocked(execFile).mockImplementation((_command, _args, options, callback) => {
			const signal = options?.signal
			if (!signal) throw new Error("curl must receive the request signal")
			signal.addEventListener(
				"abort",
				() => callback?.(Object.assign(new Error("argv contains secret-token"), { code: "ABORT_ERR" }), "", ""),
				{ once: true },
			)
			return undefined as never
		})
		const request = new GitHubApiClient("secret-token", { signal: controller.signal, timeoutMs: 100 }).comment(
			comment,
		)
		const rejected = expect(request).rejects.toMatchObject({
			reason,
			outcomeUnknown: true,
			message: expect.not.stringContaining("secret-token"),
		})
		if (reason === "cancelled") controller.abort()
		else await vi.advanceTimersByTimeAsync(100)
		await rejected
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("clears request resources after success", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ id: 1, html_url: "https://github.com/owner/repo/issues/1#comment-1" })),
		)
		const controller = new AbortController()
		const removeListener = vi.spyOn(controller.signal, "removeEventListener")
		await expect(
			new GitHubApiClient("token", { signal: controller.signal }).comment(comment),
		).resolves.toMatchObject({ action: "comment", id: 1 })
		expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function))
	})
})
