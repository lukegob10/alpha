# Vertex Gateway Agent Handoff

Use this when asking another coding agent to port the Vertex/GCP gateway work from this fork into another Roo/Rue-derived extension.

## Source Of Truth

The implementation already exists here:

```powershell
cd F:\roo-fork\Roo-Code-Forked
git fetch --all --tags
git checkout refresh/vertex-gateway-main-20260330
```

The commits to inspect are:

```text
8b9229069 chore: snapshot vertex gateway helix refresh baseline
dca345a78 fix: make vertex gateway validation dual mode
45d8c6478 chore: refresh vertex gateway replay patch
```

Do not start from the currently checked-out `safety/vertex-gateway-pre-refresh-20260330` branch unless you also apply `dca345a78`; that safety branch has an older validation behavior. The refreshed branch above is the better reference.

`fc6768b3d fix: persist buffered auto-approve commands` is adjacent SettingsView work, not part of the provider gateway itself. Only port it if the target app has the same settings-buffer persistence problem.

## Goal

Implement a Vertex/GCP gateway mode for both:

- Vertex Gemini
- Anthropic on Vertex

The gateway mode must:

- keep native provider paths, streaming, and native tool behavior where possible
- route through a configurable gateway base URL
- authenticate with a Helix command that returns a bearer token
- cache and refresh the Helix token
- retry once after 401/403 by forcing a token refresh
- trust a configured corporate PEM CA bundle
- optionally route specific models to alternate project/location/model/header settings
- keep normal non-gateway Vertex usage working

## Files To Study And Port

In the source repo, inspect this exact diff:

```powershell
cd F:\roo-fork\Roo-Code-Forked
git diff --stat 8b9229069^..dca345a78
git diff 8b9229069^..dca345a78 -- `
  packages/types/src/provider-settings.ts `
  src/api/providers/anthropic-vertex.ts `
  src/api/providers/gemini.ts `
  src/api/providers/utils/helix-token-manager.ts `
  src/api/providers/utils/vertex-gateway-transport.ts `
  src/shared/checkExistApiConfig.ts `
  webview-ui/src/components/settings/providers/Vertex.tsx `
  webview-ui/src/utils/validate.ts
```

Port these files conceptually, adapting to the target repo's current structure:

```text
packages/types/src/provider-settings.ts
src/api/providers/anthropic-vertex.ts
src/api/providers/gemini.ts
src/api/providers/utils/helix-token-manager.ts
src/api/providers/utils/vertex-gateway-transport.ts
src/shared/checkExistApiConfig.ts
webview-ui/src/components/settings/providers/Vertex.tsx
webview-ui/src/utils/validate.ts
webview-ui/src/i18n/locales/en/settings.json
```

Port or recreate these tests:

```text
src/api/providers/__tests__/anthropic-vertex.spec.ts
src/api/providers/__tests__/gemini.spec.ts
src/api/providers/utils/__tests__/helix-token-manager.spec.ts
src/shared/__tests__/checkExistApiConfig.spec.ts
webview-ui/src/components/settings/providers/__tests__/Vertex.spec.tsx
webview-ui/src/utils/__tests__/validate.spec.ts
```

## Configuration Contract

Add these Vertex provider settings:

```ts
gatewayBaseUrl?: string
projectId?: string
location?: string
pemCaBundlePath?: string
helixCommand?: string
helixParseMode?: "raw_stdout" | "json_field"
helixTokenKey?: string
refreshIntervalMinutes?: number
modelRoutingMap?: string | Record<string, {
  projectId?: string
  location?: string
  modelOverride?: string
  extraHeaders?: Record<string, string>
}>
```

Keep backward compatibility with existing Roo/Rue keys:

```ts
vertexProjectId?: string
vertexRegion?: string
```

Project/location resolution should prefer the new canonical keys, then fall back:

```text
projectId = projectId || vertexProjectId
location = location || vertexRegion
```

Gateway mode is active only when gateway-specific fields are present. Normal Vertex mode must still work with only project/location and regular Google credentials.

## Helix Token Manager Behavior

Create or port `HelixTokenManager`.

Required behavior:

- execute `helixCommand`
- support `raw_stdout`
- support `json_field`
- allow nested JSON token paths such as `credentials.access_token`
- strip a leading `Bearer `
- reject empty output
- reject tokens with whitespace or non-header-safe characters
- cache token in process
- refresh based on `refreshIntervalMinutes`
- expose a force-refresh path for retry after 401/403
- never log the token

## Gateway Transport Behavior

Create or port `configureVertexGatewayTransport`.

Required behavior:

- resolve and validate `pemCaBundlePath`
- set `SSL_CERT_FILE`
- set `NODE_EXTRA_CA_CERTS`
- where possible, configure undici with a CA dispatcher loaded from the PEM
- leave existing proxy behavior alone
- fail clearly if PEM path is missing, empty, or not a file

## Anthropic Vertex Provider Behavior

In the Anthropic Vertex provider:

- keep the existing SDK-native path when gateway mode is not configured
- when gateway mode is configured:
    - normalize `gatewayBaseUrl`; if it has no path, append `/v1`
    - create `AnthropicVertex` with `baseURL: gatewayBaseUrl`
    - use a GoogleAuth shim that does not inject normal Google OAuth headers
    - add `Authorization: Bearer <helix-token>` in request options
    - use effective `projectId`, `location`, and model after `modelRoutingMap` overrides
    - cache per-project/location clients
    - retry once on 401/403 after forcing Helix token refresh
- preserve existing streaming chunk parsing and native tool conversion
- preserve the cache-control fallback if the backend rejects prompt caching with an organization/cache_control error

## Gemini Vertex Provider Behavior

In the Gemini provider:

- keep normal Google Gemini API behavior unchanged
- keep standard Vertex behavior unchanged when gateway mode is absent
- when using Vertex plus gateway mode:
    - configure the gateway base URL on the Vertex client/http options
    - inject `Authorization: Bearer <helix-token>`
    - apply `modelRoutingMap` overrides for `projectId`, `location`, `modelOverride`, and `extraHeaders`
    - retry once on 401/403 after forcing Helix token refresh
- preserve native Gemini streaming and tool-calling behavior

## Validation Rules

Do not require gateway fields for ordinary Vertex usage.

Validation should be dual-mode:

- Always require project/location for Vertex, accepting either:
    - `projectId` and `location`
    - `vertexProjectId` and `vertexRegion`
- If any gateway trigger field is set, require all gateway required fields:
    - `gatewayBaseUrl`
    - `pemCaBundlePath`
    - `helixCommand`

Gateway trigger fields:

```text
gatewayBaseUrl
pemCaBundlePath
helixCommand
helixParseMode
helixTokenKey
refreshIntervalMinutes
modelRoutingMap
```

This dual-mode validation is the important fix from `dca345a78`.

## Settings UI Rules

Add Vertex settings controls for:

- Google Cloud project ID
- Google Cloud region/location
- gateway base URL
- PEM CA bundle path
- Helix command
- Helix parse mode
- Helix token key
- token refresh interval
- model routing map JSON

Important: in SettingsView, inputs must bind to the local cached settings state, not directly to live extension state. This is already called out in `AGENTS.md` for this repo and must be preserved in the target project if it has the same architecture.

## Suggested Agent Prompt

Give the target coding agent this prompt:

```text
Port the Vertex/GCP gateway implementation from:

F:\roo-fork\Roo-Code-Forked
branch: refresh/vertex-gateway-main-20260330

Use these commits as the source reference:
- 8b9229069 chore: snapshot vertex gateway helix refresh baseline
- dca345a78 fix: make vertex gateway validation dual mode
- 45d8c6478 chore: refresh vertex gateway replay patch

In the source repo, inspect:

git diff 8b9229069^..dca345a78

Implement the same Vertex gateway mode in the current repo for both Vertex Gemini and Anthropic-on-Vertex. Do not blindly apply the patch unless the target repo is close enough; adapt it to the current provider architecture.

Required behavior:
- Gateway mode is opt-in via Vertex settings.
- Normal non-gateway Vertex usage still works.
- Gateway requests use gatewayBaseUrl.
- Helix command produces a bearer token.
- Token is cached, refreshed, and force-refreshed once after 401/403.
- PEM CA bundle is configured for Node/undici fetch.
- modelRoutingMap can override projectId, location, modelOverride, and extraHeaders per model.
- Settings validation is dual-mode: gateway fields are required only if gateway config is partially/fully present.
- Add/port tests for Helix token parsing/cache/refresh, Gemini retry, Anthropic retry, model routing, validation, and Settings UI fields.

Main files to inspect in the source repo:
- packages/types/src/provider-settings.ts
- src/api/providers/anthropic-vertex.ts
- src/api/providers/gemini.ts
- src/api/providers/utils/helix-token-manager.ts
- src/api/providers/utils/vertex-gateway-transport.ts
- src/shared/checkExistApiConfig.ts
- webview-ui/src/components/settings/providers/Vertex.tsx
- webview-ui/src/utils/validate.ts
- webview-ui/src/i18n/locales/en/settings.json
- docs/vertex-gateway-upgrade-runbook.md

Before editing, compare the target repo's current provider implementation to the source and choose the smallest compatible port. After editing, run the provider and webview tests that cover these areas.
```

## Verification Checklist

The target implementation is not done until these pass or are manually verified:

- Standard Vertex config without gateway fields validates and still works.
- Partial gateway config fails validation with a clear message.
- Full gateway config validates.
- Helix raw stdout token is accepted.
- Helix JSON field token is accepted.
- Empty or unsafe Helix token is rejected.
- Gemini Vertex gateway call sends `Authorization: Bearer <token>`.
- Anthropic Vertex gateway call sends `Authorization: Bearer <token>`.
- 401/403 causes exactly one forced token refresh and retry.
- `modelRoutingMap` overrides are applied.
- PEM path is validated and configured.
- Settings fields persist through the local cached settings state before save.
