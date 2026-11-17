# Sandbox Key authorization

CRS can verify an existing caller API Key for an explicitly granted Sandbox service without entering the model request pipeline. ChatCRS remains an HTTP management client; the verifier runs in CRS. This extension does not install a Sandbox runtime, provide a task website, or confer model permissions on Sandbox applications.

## Operator grant

For a new application that only needs Sandbox access, create its CRS Key through
`POST /admin/api-keys` with explicit `"permissions":["sandbox"]` and a fixed
expiry, then assign the independent grant below. The same permissions value is
accepted by the single/batch create and update routes. Pure Sandbox permissions
are rejected by the shared model authentication middleware with HTTP403 before
client checks, concurrency reservation or model dispatch, including Azure OpenAI
and token-count routes. Adding a model permission deliberately enables that model
service alongside Sandbox use; its ordinary service checks still apply.

`permissions:[]`, omitted permissions and the legacy `all` value retain their
existing meaning of all model services. They do not mean Sandbox-only. Conversely,
`permissions:["sandbox"]` alone grants no Sandbox access: a valid, enabled Key
still requires its own explicit grant, image allowlist and resource budget.

Use an existing CRS Admin session as an explicit `Authorization: Bearer` header. These routes reject cookie-only requests, ordinary API Keys, Codex management Keys, and conflicting credentials. They do not log in or fall back to a second identity.

| Method | Path                            | Result                                                          |
| ------ | ------------------------------- | --------------------------------------------------------------- |
| PUT    | `/admin/sandbox-grants/{keyId}` | Replace the complete independent grant; returns `success/data`. |
| GET    | `/admin/sandbox-grants/{keyId}` | Read safe grant metadata, never the caller Key.                 |
| DELETE | `/admin/sandbox-grants/{keyId}` | Revoke the grant; returns `key_id/revoked/version`.             |

PUT body:

```json
{
  "enabled": true,
  "caller_id": "trusted-application",
  "actions": ["create", "list", "connect", "exec", "files", "renew", "delete", "ports"],
  "allowed_images": ["python:3.11-slim"],
  "allowed_ports": [44772],
  "limits": {
    "max_sandboxes": 2,
    "max_cpu_millis": 2000,
    "max_memory_mib": 2048,
    "max_ttl_seconds": 600
  },
  "expires_at": null
}
```

The Key must exist and not be deleted. The grant is keyed by its stable CRS Key ID. Administrators assign `caller_id` deliberately: retain the same caller when replacing credentials for one application, and use different callers for independent resource owners. A Key ID or caller string supplied by an unverified HTTP caller never establishes ownership.

Images are exact references (no wildcards), ports are integer allowlists, and actions are an explicit subset of the documented enum. An empty image/port/action list is invalid. `limits` requires all four positive integer fields: at most 32 instances, 32000 CPU milliseconds, 98304 MiB, and 60–7200 seconds of total instance lifetime. CPU/memory limits describe the aggregate active caller budget. The Sandbox service must atomically reserve and enforce these limits, enforce image/port/action permissions and instance ownership, reconcile uncertain creates, and release budgets only after confirmed cleanup. CRS's model concurrency and costs do not track a Sandbox lifetime.

`expires_at` may be omitted/null for no extra grant deadline or specify a future timestamp. The effective verification expiry is the earlier of the Key and grant deadlines. `enabled:false` suspends an otherwise complete grant. Replacing a grant changes its version; DELETE is idempotent. Metadata contains no raw Key, model credential, or model usage data. Concurrent operator edits follow Redis SET last-write-wins; read back after applying a change.

## Caller verification

Send `POST /auth/sandbox/verify` with an empty JSON object `{}` and the caller's existing CRS API Key in `Authorization: Bearer` or `x-api-key`. Identical dual headers are accepted; contradictory/duplicate headers, cookie-only identity, query credentials, and caller claims in the body are rejected. Keep credentials in the application's existing protected profile; never place them in a URL, frontend bundle, or logs.

Success is HTTP200 with:

```json
{
  "schema_version": 1,
  "active": true,
  "key_id": "key-id",
  "caller_id": "trusted-application",
  "expires_at": null,
  "grant": {
    "version": "opaque-64-character-hex-version",
    "actions": ["create", "list", "connect", "exec", "files", "renew", "delete", "ports"],
    "allowed_images": ["python:3.11-slim"],
    "allowed_ports": [44772],
    "limits": {
      "max_sandboxes": 2,
      "max_cpu_millis": 2000,
      "max_memory_mib": 2048,
      "max_ttl_seconds": 600
    }
  }
}
```

The verifier checks the current salted Key digest, enabled/deleted/expiry state and associated user's enabled state. It reads current and legacy hash indexes without backfilling or deleting them. Activation-mode Keys that have not been activated return401; use a fixed/explicitly activated Key. This endpoint does not activate Keys, update last-use data, query or consume model usage, reserve model concurrency, or apply model client/permissions restrictions. Model `permissions=[]/all` grants no Sandbox permission. An absent, disabled, expired, or revoked Sandbox grant returns403. Invalid credentials return401, malformed requests400/415, and backend failures503 with sanitized errors. No fallback to Admin or another Key occurs.

A valid, active Key without an active grant receives `{"active":false,"error":"sandbox_access_denied","key_id":"its-own-key-id"}`. This self-identification runs only after the credential digest, Key lifecycle and owner checks have succeeded;401 and503 responses never contain a Key ID. An operator can use this non-secret ID for a deliberate Admin grant without moving the raw Key to the operator's machine or calling model `key-info`. It confers no Sandbox access, caller identity, grant metadata or model permission.

## Revocation status for an already authorized gateway capability

`POST /auth/sandbox/status` accepts only:

```json
{ "key_id": "key-id", "grant_version": "version-from-verify" }
```

It returns only `{"schema_version":1,"active":true}` or `false`. Unknown/missing/disabled/deleted/expired/unactivated Keys, disabled users, missing/expired/revoked grants, incorrect versions, and same-ID Key regeneration all return `active:false`. Storage/user lookup failures return503, and the consumer must fail closed. No Key, caller identity, limits, or grant data are returned. The version is a domain-separated HMAC of Key ID, current credential digest, and grant revision under existing server secret material; it reveals neither the stored digest nor the raw Key. The public version is opaque, changes on grant PUT or Key regeneration, and must not be treated as an editable revision or an authorization token.

This status route is deliberately not standalone authorization. A gateway must first verify its own signed capability binding caller, Key ID, grant version, Sandbox ID, port/action and deadline. Only then may it consult status and serve the corresponding owned resource. It must bound the deadline by the instance lifetime, recheck revocation for every data request, and deny access on non-200 or `active:false`. Possession of a status reference alone cannot authorize a Sandbox action. Deletion/TTL cleanup must remain possible through trusted backend lifecycle authority after caller revocation.

Both public routes have a 2 KiB JSON body limit, no-store responses, and a bounded per-process limiter (600 requests/minute/IP; at most1024 active IP buckets). This is an abuse guard, not distributed quota accounting. Deploy behind the existing trusted HTTPS ingress and keep any upstream debug request interception away from credential endpoints. The routes are mounted before the general model body/debug pipeline. Do not cache successful status indefinitely; this implementation performs fresh reads and creates no revocation propagation delay of its own.

Server request logging omits request/response bodies, query strings, credential identity metadata and header-derived User-Agent/Referer values for `/web/auth/*` and `/auth/sandbox/*`. Responses and authentication behavior are unchanged. These prefixes also bypass the HTTP debug interceptor when `DEBUG_HTTP_TRAFFIC=true`, including unknown child routes. Keep this policy when adding another interceptor; ordinary model route logging remains unchanged. Do not use real login credentials for log validation: synthetic tests cover both request logging and an enabled debug interceptor.

## Verification and rollout

```bash
npm test -- --runInBand tests/sandboxAuthorization.test.js tests/sandboxAuthorizationRoutes.test.js
```

Tests use synthetic Redis adapters and HTTP callers, with no production Keys, model calls, Redis daemon or account changes. They cover permissions, lifecycle rejection, no-activation/no-model writes, malformed inputs, budget schemas, caller metadata, Key rotation, grant update/revocation, status non-disclosure, bounded parsers/limiters and Admin isolation. Passing tests does not establish deployment or native Sandbox SDK compatibility. Deploy the tested additive routes and service into the active server release, compare source against that release, preserve existing model/Codex APIs, and validate the real grant and gateway separately before advertising a Sandbox endpoint.
