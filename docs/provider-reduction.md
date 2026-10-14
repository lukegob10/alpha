# Provider reduction

Alpha supports four chat/model connections: GCP Vertex AI (`vertex`), VS Code LM API
(`vscode-lm`), Stellar (`stellar`), and OpenAI Compatible (`openai`). GCP Vertex AI is
the only embedding provider. Model vendors exposed through these connections do
not create additional Alpha providers.

The reduction removes dedicated Anthropic, Amazon Bedrock, Baseten, DeepSeek,
Fireworks, Gemini API/CLI, LiteLLM, LM Studio, MiniMax, Mistral, Moonshot, Ollama,
OpenAI Codex, OpenAI Native, OpenRouter, Poe, Qwen Code, Requesty, SambaNova,
Unbound, Vercel AI Gateway, xAI, and Z AI connections. Their authentication,
catalogs, model fetchers, UI controls, and exclusive tests are removed. The
OpenRouter-only image-generation experiment is retired as well.

Vertex retains Claude, Gemini, and OpenAI protocol partner routes, direct GCP
authentication, and the existing gateway/Helix configuration. Stellar retains its
gateway/Helix behavior. OpenAI Compatible retains endpoint, header, model, Azure
compatibility, and streaming configuration. VS Code LM retains host-discovered
models, provider state, tool ordering, usage, cancellation, and replay behavior.

Anthropic message types remain the existing shared transcript representation.
Anthropic/Vertex, Google GenAI, Google authentication, and OpenAI SDK dependencies
remain where the four connections consume them. Removing a dedicated provider
does not remove a wire format needed by a retained connection.

Saved unsupported provider identifiers remain identifiable on read; execution
must reject them with an unsupported-provider error. Users select an approved
connection explicitly. Unknown identifiers must never be cleared into the default
provider. Historical transcripts and evaluation records remain readable. Existing
index identities continue to separate providers, models, dimensions, and gateway
configuration, preventing old vectors from being treated as Vertex vectors.

Task creation and history resume validate the provider before changing the active
task lifecycle. Replacing a running task's API configuration constructs the new
handler before committing the change, so an unsupported saved setup leaves the
current handler intact. The exact VS Code 1.122.1 smoke gate checks that every
retired provider and an unknown provider reject execution while the extension
stays active and can return to a supported connection.

The process-local scripted `fake-ai` implementation remains an internal testing
seam for the real extension harness. It is absent from public provider choices and
requires a live implementation or a registered process-local ID. A saved profile
cannot restore its executable callbacks after host restart.

The installed-extension model campaign uses OpenAI Compatible (`--provider openai`),
`OPENAI_API_KEY`, and optional `OPENAI_BASE_URL`. Live endpoint E2E tests use the same
connection plus `ALPHA_E2E_MODEL_ID`. CI evaluator runs require `EVALS_MODEL_ID`.
Credentials are injected at execution rather than written into campaign settings.
Scripted and VS Code LM fixture harnesses remain available without live credentials.

Regression coverage checks the public registry and factory, rejects retired and
unknown IDs, preserves imported profile data, and verifies Vertex-only indexing
reconfiguration. Invalid embedding settings retire the active services before
reporting an error; explicitly switching to Vertex resets the old model dimension.
Constructing an unconfigured Vertex chat handler does not resolve Google ADC until
the first request. Claude-on-Vertex requests forward the task cancellation signal.

Use `pnpm test:core:confidence` for the combined exact-host and deterministic
managed-agent gate. It runs the smoke, core-loop, completion-idle, and managed-agent
acceptance suites on VS Code 1.122.1, then supplies the fresh completion capture to
certification. Standalone certification requires that capture via
`ALPHA_COMPLETION_IDLE_EVIDENCE`; without it, the optional replay test is skipped
and strict certification correctly refuses to report a pass. These scripted gates
do not certify live credentials or replace the matrix's pending integration work.
