import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { parse } from "../packages/evals/node_modules/yaml/dist/index.js"

const repoRoot = path.resolve(import.meta.dirname, "..")
const privateRoot = path.resolve(process.env.EVALS_PRIVATE_BENCHMARK_ROOT ?? path.join(repoRoot, "..", "Alpha-Code-private-evals"))
const suite = parse(await fs.readFile(path.join(repoRoot, "evals", "frontier-v1.yaml"), "utf8"))
const bundleRoot = path.join(privateRoot, "frontier-v1-graders")
await fs.mkdir(bundleRoot, { recursive: true })
await fs.writeFile(path.join(privateRoot, "README.md"), "# Alpha private benchmark\n\nContains holdout prompts/workspaces, hidden graders, gold solutions, and broken calibration solutions. Never mount this repository into an agent container.\n")

const entries = []
for (const task of suite.tasks) {
	const graderDir = path.join(bundleRoot, task.id)
	await fs.mkdir(graderDir, { recursive: true })
	const privateGrader = task.graders.find((grader) => grader.bundleId)
	if (!privateGrader) throw new Error(`Task ${task.id} has no private grader`)
	await fs.writeFile(path.join(graderDir, `${privateGrader.alias}.js`), hiddenGrader(task.id))
	entries.push({ id: `${task.id}.${privateGrader.alias.replaceAll("_", "-")}`, version: 1, entrypoint: `${task.id}/${privateGrader.alias}.js` })
  const calibration = path.join(privateRoot, "calibration", task.id)
  await fs.mkdir(path.join(calibration, "gold"), { recursive: true })
  await fs.writeFile(path.join(calibration, "gold", "workflow.js"), goldSource(task.id))
  for (const [id, source] of Object.entries(brokenSources(task.id))) {
    const dir = path.join(calibration, "broken", id)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "workflow.js"), source)
  }
  if (task.partition === "holdout") await writeHoldout(privateRoot, task)
}
const contentDigest = await digestTree(bundleRoot)
const manifest = {
  schemaVersion: 1,
  id: "frontier-v1-graders",
  version: 1,
  digest: contentDigest,
  runtimeImageDigest: sha256("node:20.19.2-private-grader"),
  readOnly: true,
  graders: entries,
}
await fs.writeFile(path.join(bundleRoot, "bundle.json"), JSON.stringify(manifest, null, 2) + "\n")
console.log(JSON.stringify({ privateRoot, tasks: suite.tasks.length, holdouts: suite.tasks.filter((task) => task.partition === "holdout").length, contentDigest }, null, 2))

async function writeHoldout(root, task) {
  const workspace = path.join(root, task.fixture)
  await fs.mkdir(path.join(workspace, "src"), { recursive: true })
  await fs.mkdir(path.join(workspace, "test"), { recursive: true })
  await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: `private-${task.id}`, private: true, type: "module", scripts: { test: "node --test test/*.test.js" } }, null, 2) + "\n")
  await fs.writeFile(path.join(workspace, "prompt.md"), `A production workflow fails under duplicate and stale operations. Diagnose and repair the reducer while preserving its public API, audit semantics, and unrelated behavior. Run all tests after the final edit. Do not edit tests or inspect paths outside this workspace.\n`)
  await fs.writeFile(path.join(workspace, "src", "workflow.js"), brokenSources(task.id).baseline)
  await fs.writeFile(path.join(workspace, "test", "workflow.test.js"), `import test from "node:test"\nimport assert from "node:assert/strict"\nimport { applyOperations } from "../src/workflow.js"\ntest("applies ordered operations", () => assert.equal(applyOperations({ value: "a", revision: 1 }, [{ id: "b", value: "b", revision: 2 }]).value, "b"))\n`)
}
function goldSource(id) {
  return `export function applyOperations(initial, operations) {\n  const state = { ...initial, audit: [...(initial.audit ?? [])] }\n  const seen = new Set()\n  for (const operation of operations) {\n    if (seen.has(operation.id) || operation.revision <= state.revision) continue\n    seen.add(operation.id)\n    state.value = operation.value\n    state.revision = operation.revision\n    state.audit.push({ id: operation.id, revision: operation.revision })\n  }\n  return state\n}\nexport const workflowIdentity = ${JSON.stringify(id)}\n`
}
function brokenSources(id) {
  return {
    baseline: `export function applyOperations(initial, operations) { const state = { ...initial, audit: [...(initial.audit ?? [])] }; for (const op of operations) { state.value = op.value; state.revision = op.revision; state.audit.push({ id: op.id, revision: op.revision }) }; return state }\nexport const workflowIdentity = ${JSON.stringify(id)}\n`,
    duplicate: `export function applyOperations(initial, operations) { const state = { ...initial, audit: [...(initial.audit ?? [])] }; for (const op of operations) { if (op.revision <= state.revision) continue; state.value = op.value; state.revision = op.revision; state.audit.push({ id: op.id, revision: op.revision }) }; return state }\nexport const workflowIdentity = ${JSON.stringify(id)}\n`,
    stale: `export function applyOperations(initial, operations) { const state = { ...initial, audit: [...(initial.audit ?? [])] }; const seen = new Set(); for (const op of operations) { if (seen.has(op.id)) continue; seen.add(op.id); state.value = op.value; state.revision = op.revision; state.audit.push({ id: op.id, revision: op.revision }) }; return state }\nexport const workflowIdentity = ${JSON.stringify(id)}\n`,
  }
}
function hiddenGrader(id) {
  return `import assert from "node:assert/strict"\nimport path from "node:path"\nimport { pathToFileURL } from "node:url"\nconst root = process.env.EVAL_WORKSPACE_ROOT\nif (!root) throw new Error("EVAL_WORKSPACE_ROOT missing")\nconst { applyOperations, workflowIdentity } = await import(pathToFileURL(path.join(root, "src/workflow.js")).href + "?hidden=" + Date.now())\nassert.equal(workflowIdentity, ${JSON.stringify(id)})\nconst initial = { value: "current", revision: 5, audit: [{ id: "old", revision: 5 }] }\nconst result = applyOperations(initial, [\n  { id: "stale", value: "stale", revision: 4 },\n  { id: "same", value: "same", revision: 5 },\n  { id: "next", value: "accepted", revision: 6 },\n  { id: "next", value: "duplicate", revision: 7 },\n])\nassert.deepEqual(result, { value: "accepted", revision: 6, audit: [{ id: "old", revision: 5 }, { id: "next", revision: 6 }] })\nassert.deepEqual(initial, { value: "current", revision: 5, audit: [{ id: "old", revision: 5 }] })\n`
}
async function digestTree(root) {
  const files = []
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (path.relative(root, full).replaceAll("\\", "/") !== "bundle.json") files.push(full)
    }
  }
  await walk(root)
  const rows = []
  for (const file of files.sort()) rows.push([path.relative(root, file).replaceAll("\\", "/"), sha256(await fs.readFile(file))])
  return sha256(JSON.stringify(rows))
}
function sha256(value) { return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}` }
