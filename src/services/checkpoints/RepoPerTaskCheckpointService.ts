import * as path from "path"

import { CheckpointServiceOptions } from "./types"
import { ShadowCheckpointService } from "./ShadowCheckpointService"
import { resolveTaskDirectoryPath } from "../../utils/storage"

export class RepoPerTaskCheckpointService extends ShadowCheckpointService {
	public static create({ taskId, workspaceDir, shadowDir, log = console.log }: CheckpointServiceOptions) {
		return new RepoPerTaskCheckpointService(
			taskId,
			path.join(resolveTaskDirectoryPath(shadowDir, taskId), "checkpoints"),
			workspaceDir,
			log,
		)
	}
}
