import os from "os"

import { RepoPerTaskCheckpointService } from "../RepoPerTaskCheckpointService"

describe("RepoPerTaskCheckpointService task storage", () => {
	it("rejects task IDs that escape checkpoint storage", () => {
		expect(() =>
			RepoPerTaskCheckpointService.create({
				taskId: "../../outside",
				shadowDir: os.tmpdir(),
				workspaceDir: os.tmpdir(),
			}),
		).toThrow("Invalid task ID")
	})
})
