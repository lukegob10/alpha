import * as vscode from "vscode"

import { getGitHubProxyConfig } from "../GitHubApiClient"

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
		})
	})

	it("falls back to environment proxy settings", () => {
		process.env.HTTPS_PROXY = "http://env-proxy.example.com:8080"

		expect(getGitHubProxyConfig("https://api.github.com/repos/owner/repo")).toEqual({
			proxyUrl: "http://env-proxy.example.com:8080",
			strictSSL: true,
			source: "environment",
		})
	})

	it("honors environment no_proxy entries", () => {
		process.env.HTTPS_PROXY = "http://env-proxy.example.com:8080"
		process.env.NO_PROXY = "api.github.com"

		expect(getGitHubProxyConfig("https://api.github.com/repos/owner/repo")).toEqual({
			strictSSL: true,
			source: "none",
		})
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
