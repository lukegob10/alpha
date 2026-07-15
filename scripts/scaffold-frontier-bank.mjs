/**
 * The original version of this script created 28 noun-substituted copies of
 * one reducer fixture. That behavior is intentionally retired: rerunning it
 * would destroy the versioned authoring contracts and task diversity work.
 *
 * New tasks are created through the validated authoring CLI:
 *
 *   pnpm --filter @alpha-code/evals benchmark:template -- \
 *     --id <task-id> --profile <compact|medium|long> \
 *     --partition <development|regression>
 *
 * M3's archetype-specific builders may call the same contract library, but no
 * command may overwrite the complete bank with a generic fixture.
 */

throw new Error(
	"The monolithic frontier scaffold is retired. Use `pnpm --filter @alpha-code/evals benchmark:template` for one validated task at a time.",
)
