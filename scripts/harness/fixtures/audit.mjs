import { collectBenchmarks } from "../audit-benchmarks.mjs"

export function reviewReport(agent = "01") {
	return {
		agent,
		domain: "fixture domain",
		coverage: ["src/fixture.ts"],
		upstream: { sha: "a".repeat(40), paths: [], alignment: "adapter specific", divergences: [] },
		findings: [],
		validation: { ran: [], recommended: [] },
		scriptCoverage: [],
		limits: [],
		closure: "reviewed",
	}
}

export async function benchmarkReceipt(root) {
	return collectBenchmarks(root, async (entry) => {
		console.log(
			JSON.stringify(
				entry.includes("StepContext")
					? {
							node: process.version,
							fixtureBytes: 200,
							fixtureDigest: "a".repeat(64),
							contextDigest: "b".repeat(64),
							warmups: 3,
							samplesMs: Array(10).fill(1),
							medianMs: 1,
						}
					: {
							benchmark: "subagent-none-context-capture",
							node: process.version,
							provider: "none",
							samples: 5,
							capturesPerSample: 2,
							messageCharacters: 4096,
							observations: [false, true].flatMap((native) =>
								[0, 100, 1000].map((turns) => ({
									native,
									turns,
									messages: turns * 2,
									contentReads: 0,
									captures: 10,
									meanCaptureMs: 1,
									medianCaptureMs: 1,
									manifestDigest: "c".repeat(64),
								})),
							),
						},
			),
		)
	})
}
