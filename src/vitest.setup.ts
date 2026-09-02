import nock from "nock"

import "./utils/path" // Import to enable String.prototype.toPosix().

// Keep test git subprocesses non-interactive without inheriting a custom pager.
// simple-git 3.36 correctly rejects executable pager environment variables by default.
delete process.env.GIT_PAGER
delete process.env.PAGER

// Disable network requests by default for all tests.
nock.disableNetConnect()

export function allowNetConnect(host?: string | RegExp) {
	if (host) {
		nock.enableNetConnect(host)
	} else {
		nock.enableNetConnect()
	}
}

// Global mocks that many tests expect.
global.structuredClone = global.structuredClone || ((obj: any) => JSON.parse(JSON.stringify(obj)))
