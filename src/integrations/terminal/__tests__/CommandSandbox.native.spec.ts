import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { execa } from "execa"
import { prepareSandboxedCommand, shellInvocation } from "../CommandSandbox"
import { ExecaTerminal } from "../ExecaTerminal"

// Point at the checksum-verified release package to run this gate without another download.
vi.mock("../SandboxRuntime", () => ({
	ensureSandboxRuntime: async () => process.env.ALPHA_SANDBOX_NATIVE_RUNTIME!,
}))

describe.skipIf(!process.env.ALPHA_SANDBOX_NATIVE_RUNTIME)("native command sandbox", () => {
	let fixture: string
	let root: string
	let outside: string
	let storage: string
	beforeEach(async () => {
		fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-native-sandbox-")))
		root = path.join(fixture, "workspace")
		outside = path.join(fixture, "outside")
		storage = path.join(fixture, "storage")
		await Promise.all([root, outside, storage].map((directory) => fs.mkdir(directory)))
		await fs.writeFile(path.join(outside, "sentinel.txt"), "unchanged")
	})
	afterEach(async () => {
		await fs.rm(fixture, { recursive: true, force: true })
	})

	const run = async (root: string, storage: string, script: string, readOnly = false) => {
		const launch = await prepareSandboxedCommand(
			{ workspaceRoots: [root], cwd: root, storagePath: storage, readOnly },
			[process.execPath, "-e", script],
		)
		launch.assertScope()
		return execa(launch.executable, [...launch.args], {
			cwd: root,
			env: { ...process.env, ...launch.env },
			shell: false,
			windowsHide: true,
			timeout: 30_000,
			reject: false,
		})
	}

	it("allows workspace and cache writes; blocks outside writes, deletes, renames and junction escapes in descendants", async () => {
		await fs.symlink(outside, path.join(root, "outside-link"), process.platform === "win32" ? "junction" : "dir")
		const script = `
const fs=require('fs'),path=require('path'),cp=require('child_process');
fs.writeFileSync('inside.txt','ok');
fs.writeFileSync(path.join(process.env.TEMP,'cache.txt'),'cache');
const sentinel=${JSON.stringify(path.join(outside, "sentinel.txt"))};
if(fs.readFileSync(sentinel,'utf8')!=='unchanged')throw Error('outside reads failed');
let blocked=0;
for(const operation of [()=>fs.writeFileSync(sentinel,'changed'),()=>fs.unlinkSync(sentinel),()=>fs.renameSync(sentinel,'stolen.txt'),()=>fs.writeFileSync('outside-link/new.txt','escape'),()=>fs.writeFileSync('../outside/new.txt','escape')]) {
 try {operation()} catch(e) {if(['EACCES','EPERM','EROFS'].includes(e.code))blocked++;else throw e}
}
const child=cp.spawnSync(process.execPath,['-e',"require('fs').writeFileSync("+JSON.stringify(sentinel)+",'child escape')"],{encoding:'utf8',windowsHide:true});
if(child.status===0)throw Error('child escaped');
if(blocked!==5)throw Error('outside operation escaped: '+blocked);
console.log('WRITE_BOUNDARY_OK');`
		const result = await run(root, storage, script)
		expect(result.stderr, result.stdout).toBe("")
		expect(result.exitCode, result.stderr).toBe(0)
		expect(result.stdout).toContain("WRITE_BOUNDARY_OK")
		expect(await fs.readFile(path.join(outside, "sentinel.txt"), "utf8")).toBe("unchanged")
		expect(await fs.readFile(path.join(root, "inside.txt"), "utf8")).toBe("ok")
	}, 45_000)

	it("reuses global setup across projects without widening either project", async () => {
		const second = path.join(fixture, "second-project")
		await fs.mkdir(second)
		for (const project of [root, second]) {
			const other = project === root ? second : root
			const result = await run(
				project,
				storage,
				`const fs=require('fs');fs.writeFileSync('build.txt','ok');try{fs.writeFileSync(${JSON.stringify(path.join(other, "escaped.txt"))},'escape');process.exit(42)}catch(e){console.log('PROJECT_OK')}`,
			)
			expect(result.exitCode, result.stderr).toBe(0)
			expect(result.stdout).toContain("PROJECT_OK")
		}
	}, 45_000)

	it("allows network access and preserves read-only Plan execution", async () => {
		const server = http.createServer((_request, response) => response.end("NETWORK_OK"))
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		try {
			const address = server.address() as import("node:net").AddressInfo
			const result = await run(
				root,
				storage,
				`fetch('http://127.0.0.1:${address.port}').then(r=>r.text()).then(console.log);try{require('fs').writeFileSync('plan-write.txt','escape');process.exit(42)}catch(e){if(!['EACCES','EPERM','EROFS'].includes(e.code))throw e}`,
				true,
			)
			expect(result.exitCode, result.stderr).toBe(0)
			expect(result.stdout).toContain("NETWORK_OK")
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
	}, 45_000)

	it("cancels the sandbox and its child process tree through the inline terminal", async () => {
		const launch = await prepareSandboxedCommand({ workspaceRoots: [root], cwd: root, storagePath: storage }, [
			process.execPath,
			"-e",
			`const cp=require('child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000)`,
		])
		const terminal = new ExecaTerminal(1, root)
		let ready!: (pids: { parent: number; child: number }) => void
		const started = new Promise<{ parent: number; child: number }>((resolve) => {
			ready = resolve
		})
		const running = terminal.runCommand(
			"sandbox cancellation fixture",
			{
				onLine: (output) => {
					const match = output.match(/\{"parent":\d+,"child":\d+\}/)
					if (match) ready(JSON.parse(match[0]))
				},
				onCompleted: () => {},
				onShellExecutionStarted: () => {},
				onShellExecutionComplete: () => {},
			},
			launch,
		)
		let timer: NodeJS.Timeout | undefined
		try {
			const pids = await Promise.race([
				started,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error("Native fixture did not start")), 10_000)
				}),
			])
			await running.abort()
			await running
			for (const pid of [pids.parent, pids.child]) expect(() => process.kill(pid, 0)).toThrow()
		} finally {
			if (timer) clearTimeout(timer)
			await running.abort()
		}
	}, 30_000)

	it("runs pnpm builds and local Git writes inside the workspace", async () => {
		await fs.writeFile(
			path.join(root, "package.json"),
			JSON.stringify({
				name: "sandbox-fixture",
				version: "1.0.0",
				packageManager: "pnpm@10.8.1",
				scripts: { build: "node build.cjs" },
			}),
		)
		await fs.writeFile(
			path.join(root, "build.cjs"),
			"const fs=require('fs');fs.mkdirSync('dist');fs.writeFileSync('dist/output.txt','BUILD_OK')",
		)
		const command = `"${process.execPath}" -e "console.log('QUOTED_PATH_OK')" && pnpm run build && git init --quiet && git add package.json`
		const launch = await prepareSandboxedCommand(
			{ workspaceRoots: [root], cwd: root, storagePath: storage },
			shellInvocation(command, process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh"),
		)
		launch.assertScope()
		const result = await execa(launch.executable, [...launch.args], {
			cwd: root,
			env: { ...process.env, ...launch.env },
			shell: false,
			windowsHide: true,
			timeout: 30_000,
			reject: false,
		})
		expect(result.exitCode, result.stderr).toBe(0)
		expect(await fs.readFile(path.join(root, "dist/output.txt"), "utf8")).toBe("BUILD_OK")
		await expect(fs.access(path.join(root, ".git/index"))).resolves.toBeUndefined()
	}, 45_000)
})
