# Benchmark Version Boundary

**Main repository branch:** `codex/frontier-benchmark-expansion`  
**Public suite:** `frontier-v1@1`  
**Private bundle:** `frontier-v1-graders@2`  
**Private bundle schema:** 2  
**Private bundle content digest:** `sha256:0f94925970b79f1d3e0dcb65a8b15832711c014cd0e443c2c2ce36b40bd7072e`

## Contract

- Public task manifests identify private grader bundles by ID and version only.
- Private content remains outside the main repository.
- The trusted controller verifies bundle ID, version, content digest, required grader identities, and contained paths before grading.
- Public and private repositories keep independent Git history.
- Released suite and bundle versions are immutable. Content changes require a new version and recalibration.

## Current state

`frontier-v1@1` remains `calibrating`. The bundle identity above is the keylessly admitted private dependency for the current 40-task bank. All 40 packages passed initial-state, gold, broken-solution, determinism, mutation, executable-entrypoint, identity-alignment, and isolation gates. Model calibration, required human review, and a clean frozen baseline remain release gates.
