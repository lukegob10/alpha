# Alpha Server Communication Points

This document inventories code paths in this repo that communicate with Alpha-operated services or account/cloud infrastructure. It focuses on the VS Code extension and adjacent CLI paths, not generic third-party model providers such as Anthropic, OpenAI, Gemini, Ollama, OpenRouter, Requesty, etc.

Default legacy service hosts are defined in `packages/cloud/src/config.ts`:

| Host                   | Default                         | Override                           |
| ---------------------- | ------------------------------- | ---------------------------------- |
| Clerk auth host        | `https://clerk.roocode.com`     | `CLERK_BASE_URL`                   |
| Cloud app/API host     | `https://app.roocode.com`       | `ROO_CODE_API_URL`                 |
| Model proxy            | `https://api.roocode.com/proxy` | `ROO_CODE_PROVIDER_URL`            |
| PostHog telemetry host | `https://ph.roocode.com`        | not currently configurable in code |
| CLI auth host          | `https://app.roocode.com`       | `ROO_AUTH_BASE_URL`                |
| CLI SDK host           | `https://cloud-api.roocode.com` | `ROO_SDK_BASE_URL`                 |

## Extension Startup

The extension initializes cloud/account infrastructure on every activation.

Entry point:

- `src/extension.ts`
    - imports `CloudService`
    - creates `CloudService.createInstance(...)`
    - registers cloud telemetry with `TelemetryService`
    - registers auth/settings/user-info event handlers
    - refreshes cloud model cache on cloud auth state changes

Primary implementation:

- `packages/cloud/src/CloudService.ts`

Behavior:

- If `ROO_CODE_CLOUD_TOKEN` is set, it uses `StaticTokenAuthService` and marks the process as a cloud agent.
- Otherwise, it uses `WebAuthService`, which reads/stores Clerk credentials in VS Code SecretStorage.
- It also initializes cloud settings sync, cloud telemetry, task sharing, and retry queue support.

This means account/cloud code exists even when the user has not explicitly signed in. Network calls are mostly gated by stored credentials or user actions, but `CloudService` is still constructed during extension activation.

## Account Login And Session Refresh

Implementation:

- `packages/cloud/src/WebAuthService.ts`
- `src/activate/handleUri.ts`
- `src/core/webview/webviewMessageHandler.ts`
- `webview-ui/src/components/cloud/CloudView.tsx`
- `webview-ui/src/components/settings/providers/Roo.tsx`
- `webview-ui/src/components/chat/ShareButton.tsx`
- `webview-ui/src/components/cloud/CloudUpsellDialog.tsx`

Endpoints:

| Action                                        | Endpoint                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| Start sign-in                                 | `GET https://app.roocode.com/extension/sign-in?...` opened externally          |
| Start provider signup                         | `GET https://app.roocode.com/extension/provider-sign-up?...` opened externally |
| Start landing-page signup                     | `GET https://app.roocode.com/l/{slug}?...` opened externally                   |
| OAuth callback into extension                 | VS Code URI path `/auth/clerk/callback`                                        |
| Exchange callback code for Clerk client token | `POST https://clerk.roocode.com/v1/client/sign_ins`                            |
| Refresh session JWT                           | `POST https://clerk.roocode.com/v1/client/sessions/{sessionId}/tokens`         |
| Fetch user profile                            | `GET https://clerk.roocode.com/v1/me`                                          |
| Fetch org memberships                         | `GET https://clerk.roocode.com/v1/me/organization_memberships`                 |
| Logout/remove Clerk session                   | `POST https://clerk.roocode.com/v1/client/sessions/{sessionId}/remove`         |

Stored local keys:

| Storage                                             | Key                                       |
| --------------------------------------------------- | ----------------------------------------- |
| VS Code `globalState`                               | `clerk-auth-state`                        |
| VS Code SecretStorage                               | `clerk-auth-credentials`                  |
| VS Code SecretStorage for non-production Clerk host | `clerk-auth-credentials-{CLERK_BASE_URL}` |
| VS Code `globalState`                               | `roo-provider-model`                      |
| VS Code `globalState`                               | `roo-auth-skip-model`                     |

Triggers:

- Cloud tab connect button sends `rooCloudSignIn`.
- Cloud landing-page signup sends `cloudLandingPageSignIn`.
- Manual callback paste sends `rooCloudManualUrl`.
- Share flow can prompt connect-to-cloud first.
- Cloud provider settings can prompt cloud connection.

## Cloud Settings Sync

Implementation:

- `packages/cloud/src/CloudSettingsService.ts`
- `packages/cloud/src/CloudService.ts`
- `src/core/webview/ClineProvider.ts`
- `src/core/webview/webviewMessageHandler.ts`

Endpoints:

| Action                                         | Endpoint                                             |
| ---------------------------------------------- | ---------------------------------------------------- |
| Fetch organization and user extension settings | `GET https://app.roocode.com/api/extension-settings` |
| Update user cloud settings                     | `PATCH https://app.roocode.com/api/user-settings`    |

Stored local keys:

| Storage               | Key                     |
| --------------------- | ----------------------- |
| VS Code `globalState` | `organization-settings` |
| VS Code `globalState` | `user-settings`         |

Behavior:

- Settings fetch starts when auth state becomes `active-session`.
- Fetch timer interval is one hour on success.
- `taskSyncEnabled` toggle sends `PATCH /api/user-settings`.
- Organization settings affect allow lists, marketplace visibility, sharing, public sharing, and task sync.

## Cloud Task Sync And Telemetry Backfill

Implementation:

- `packages/cloud/src/TelemetryClient.ts`
- `packages/cloud/src/CloudService.ts`
- `packages/cloud/src/retry-queue/RetryQueue.ts`
- `src/core/task/Task.ts`

Endpoints:

| Action                        | Endpoint                                           |
| ----------------------------- | -------------------------------------------------- |
| Send cloud telemetry event    | `POST https://app.roocode.com/api/events`          |
| Upload/backfill task messages | `POST https://app.roocode.com/api/events/backfill` |

Stored local keys:

| Storage                  | Key              |
| ------------------------ | ---------------- |
| VS Code `workspaceState` | `roo.retryQueue` |

Behavior:

- Cloud telemetry is separate from PostHog telemetry.
- `CloudTelemetryClient.isTelemetryEnabled()` returns true unless `ROO_CODE_DISABLE_TELEMETRY=1`.
- It only sends when authenticated and a session token exists.
- `TASK_CONVERSATION_MESSAGE` is excluded.
- `TASK_MESSAGE` is sent only when task sync is enabled by cloud settings.
- Failed cloud telemetry requests may be stored in `roo.retryQueue` and retried later with fresh auth headers.

## Task Sharing

Implementation:

- `packages/cloud/src/CloudAPI.ts`
- `packages/cloud/src/CloudShareService.ts`
- `packages/cloud/src/CloudService.ts`
- `src/core/webview/webviewMessageHandler.ts`
- `webview-ui/src/components/chat/ShareButton.tsx`

Endpoints:

| Action                                            | Endpoint                                           |
| ------------------------------------------------- | -------------------------------------------------- |
| Create share link                                 | `POST https://app.roocode.com/api/extension/share` |
| Backfill task before sharing, if missing in cloud | `POST https://app.roocode.com/api/events/backfill` |

Behavior:

- Share button sends `shareCurrentTask`.
- The extension calls cloud share with current task ID and visibility.
- If sharing fails because the task is not found and messages are available, it uploads task messages via telemetry backfill, then retries share.
- Successful share URLs are copied to clipboard.

## Roo/Alpha Cloud Model Provider

Implementation:

- `src/api/providers/roo.ts`
- `src/api/providers/fetchers/modelCache.ts`
- `src/core/webview/webviewMessageHandler.ts`
- `src/extension.ts`
- `src/extension/api.ts`
- `webview-ui/src/components/settings/providers/Roo.tsx`
- `webview-ui/src/components/settings/providers/RooBalanceDisplay.tsx`

Endpoints:

| Action                                 | Endpoint                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| Roo model list                         | `GET https://api.roocode.com/proxy/v1/models` or equivalent model-cache helper path |
| Roo OpenAI-compatible chat/completions | `POST https://api.roocode.com/proxy/v1/chat/completions` through OpenAI SDK         |
| Roo credit balance                     | `GET https://app.roocode.com/api/extension/credit-balance`                          |
| Roo billing link opened from UI        | `https://app.roocode.com/billing`                                                   |

Behavior:

- `RooHandler` uses `ROO_CODE_PROVIDER_URL` or defaults to `https://api.roocode.com/proxy`.
- It appends `/v1` for OpenAI-compatible requests.
- API key is the cloud session token when available; otherwise it uses `"unauthenticated"` and lets the proxy reject.
- Auth state changes refresh or flush Roo model cache.
- `requestRooModels` refreshes Roo model list using the current cloud token.
- `requestRooCreditBalance` calls the cloud API credit balance endpoint.

This is not a generic third-party API path. It is Roo/Alpha's hosted model proxy and account-backed credit system.

## Marketplace And MCP Marketplace

Implementation:

- `src/services/marketplace/RemoteConfigLoader.ts`
- `src/services/marketplace/MarketplaceManager.ts`
- `src/services/marketplace/SimpleInstaller.ts`
- `webview-ui/src/components/marketplace/*`
- `webview-ui/src/components/mcp/McpView.tsx`

Endpoints:

| Action                 | Endpoint                                            |
| ---------------------- | --------------------------------------------------- |
| Fetch mode marketplace | `GET https://app.roocode.com/api/marketplace/modes` |
| Fetch MCP marketplace  | `GET https://app.roocode.com/api/marketplace/mcps`  |

Behavior:

- Marketplace view fetches data on demand.
- MCP tab has a Marketplace button that navigates to marketplace data.
- Organization cloud settings can add organization MCPs and hide marketplace MCPs.
- Installing an MCP marketplace item writes local MCP config; the later MCP server communication itself is determined by that installed server's config, not necessarily by Roo servers.

Local MCP itself:

- `src/services/mcp/McpHub.ts` manages local/global/project MCP server configs.
- Project config paths include `.alpha/mcp.json` in current code, while some older marketplace code still references `.roo/mcp.json`.
- MCP server communication can be local stdio or remote depending on user config and installed marketplace entries. The Roo server communication point is the marketplace catalog fetch, not every MCP runtime connection.

## PostHog Telemetry

There are two PostHog clients.

### Extension Host PostHog

Implementation:

- `packages/telemetry/src/PostHogTelemetryClient.ts`
- `packages/telemetry/src/TelemetryService.ts`
- `src/extension.ts`

Endpoint:

- `https://ph.roocode.com`

Behavior:

- Constructed with `process.env.POSTHOG_API_KEY || ""`.
- Registered on extension activation.
- Respects VS Code global telemetry level and user telemetry opt-in.
- Excludes `TASK_MESSAGE` and `LLM_COMPLETION`.
- Sends event and exception telemetry through `posthog-node`.

### Webview PostHog

Implementation:

- `webview-ui/src/utils/TelemetryClient.ts`
- `src/core/webview/ClineProvider.ts`
- many UI components call `telemetryClient.capture(...)`.

Endpoint:

- `https://ph.roocode.com`

Behavior:

- `ClineProvider.getStateToPostToWebview()` passes `POSTHOG_API_KEY` and `vscode.env.machineId` into webview state as `telemetryKey` and `machineId`.
- Webview initializes PostHog only if telemetry is not disabled and both key and distinct ID exist.
- Webview CSP explicitly allows `https://ph.roocode.com`.

## Cloud UI External Links

Implementation:

- `webview-ui/src/components/cloud/CloudView.tsx`
- `webview-ui/src/components/cloud/CloudAccountSwitcher.tsx`
- `webview-ui/src/components/cloud/OrganizationSwitcher.tsx`
- `webview-ui/src/components/settings/providers/RooBalanceDisplay.tsx`

Links opened externally:

| Action              | URL                                                           |
| ------------------- | ------------------------------------------------------------- |
| Visit cloud website | `https://app.roocode.com` or `ROO_CODE_API_URL`               |
| Billing             | `https://app.roocode.com/billing` or `${cloudApiUrl}/billing` |
| Create team/account | cloud app URL from state                                      |

These are user-triggered browser opens, not background fetches, but they are still Roo cloud surfaces.

## MDM Cloud Auth Requirement

Implementation:

- `src/services/mdm/MdmService.ts`

Local config paths:

| Platform | Production path                                 |
| -------- | ----------------------------------------------- |
| Windows  | `%ProgramData%\\RooCode\\mdm.json`              |
| macOS    | `/Library/Application Support/RooCode/mdm.json` |
| Linux    | `/etc/roo-code/mdm.json`                        |

Behavior:

- MDM service reads only local files.
- It does not call Roo servers directly.
- It can require cloud auth and a specific organization, which indirectly forces use of `CloudService`.

## CLI Cloud/Auth Paths

Implementation:

- `apps/cli/src/types/constants.ts`
- `apps/cli/src/commands/auth/login.ts`
- `apps/cli/src/commands/auth/logout.ts`
- `apps/cli/src/lib/sdk/client.ts`
- `apps/cli/src/commands/cli/run.ts`

Endpoints:

| Action                               | Endpoint                              |
| ------------------------------------ | ------------------------------------- |
| CLI sign-in browser flow             | `https://app.roocode.com/cli/sign-in` |
| CLI SDK TRPC                         | `https://cloud-api.roocode.com/trpc`  |
| CLI Roo provider proxy in dev script | `https://api.roocode.com/proxy`       |

Behavior:

- CLI login starts a localhost callback server and opens Roo cloud auth in the browser.
- It stores a returned token locally through CLI storage.
- CLI run code can create a TRPC client against `SDK_BASE_URL`.

## Cloud Agent / Evals Environment Hooks

Implementation:

- `packages/cloud/src/CloudService.ts`
- `packages/evals/src/cli/*`

Environment variables:

| Variable                       | Effect                                                               |
| ------------------------------ | -------------------------------------------------------------------- |
| `ROO_CODE_CLOUD_TOKEN`         | Uses static token auth instead of browser/Clerk auth                 |
| `ROO_CODE_CLOUD_ORG_SETTINGS`  | Uses static organization settings instead of fetching cloud settings |
| `ROO_CODE_DISABLE_TELEMETRY=1` | Disables `CloudTelemetryClient`                                      |

Behavior:

- Evals tooling passes `ROO_CODE_CLOUD_TOKEN` into VS Code/CLI task runs.
- Static token auth is still a cloud identity mechanism; it avoids browser login but not cloud/account semantics.

## Local Storage Related To Roo Cloud

| Area                 | Storage          | Keys                                                                |
| -------------------- | ---------------- | ------------------------------------------------------------------- |
| Auth state           | `globalState`    | `clerk-auth-state`, `roo-provider-model`, `roo-auth-skip-model`     |
| Auth credentials     | SecretStorage    | `clerk-auth-credentials`, `clerk-auth-credentials-{CLERK_BASE_URL}` |
| Cloud settings cache | `globalState`    | `organization-settings`, `user-settings`                            |
| Retry queue          | `workspaceState` | `roo.retryQueue`                                                    |
| MDM policy           | filesystem       | platform-specific `RooCode/mdm.json` or `/etc/roo-code/mdm.json`    |

## Summary Of Removal Targets For Fully Local Mode

To remove account/cloud behavior, the highest-impact surfaces are:

1. `CloudService` initialization in `src/extension.ts`.
2. The `@alpha-code/cloud` package or its imported usage from extension code.
3. Cloud account UI under `webview-ui/src/components/cloud`.
4. Roo provider account/proxy support in `src/api/providers/roo.ts` and model-cache paths for provider `"roo"`.
5. Cloud settings sync and task sharing message handlers in `src/core/webview/webviewMessageHandler.ts`.
6. Marketplace remote catalog fetching in `src/services/marketplace/RemoteConfigLoader.ts`.
7. PostHog telemetry clients in `packages/telemetry/src/PostHogTelemetryClient.ts` and `webview-ui/src/utils/TelemetryClient.ts`.
8. Cloud telemetry and retry queue in `packages/cloud/src/TelemetryClient.ts` and `packages/cloud/src/retry-queue/RetryQueue.ts`.
9. CLI cloud auth and SDK defaults in `apps/cli/src/types/constants.ts`, `apps/cli/src/commands/auth/login.ts`, and `apps/cli/src/lib/sdk/client.ts`.
10. MDM cloud-auth enforcement in `src/services/mdm/MdmService.ts`.

## Not Counted As Roo Server Communication

The repo also contains many non-Roo network paths. These are outside the scope of this inventory unless the goal becomes "all network communication":

- Anthropic/OpenAI/Gemini/Mistral/Bedrock/xAI/etc. provider APIs.
- OpenRouter, Requesty, Poe, LiteLLM, Ollama, LM Studio, Vercel AI Gateway provider APIs.
- User-configured OpenAI-compatible base URLs.
- Local Qdrant/Ollama/LM Studio URLs.
- Documentation, GitHub, marketplace.visualstudio.com, and third-party documentation links.
- MCP runtime connections defined by user-installed MCP server configs.
