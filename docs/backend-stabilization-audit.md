# Backend Stabilization Audit — E2E Sprint

Date: 2026-07-11  
Backend baseline: `438f7d26fcfa838588de820994f7a5170ff4965c` (`development`)  
Frontend baseline: not present in this workspace; direct frontend comparison remains pending the stabilized frontend commit.  
Runtime observed locally: Node `v24.14.1`; repository/runtime image target: Node `22.18.0`; package manager declared and available: Yarn `1.22.22`.

## Executive result

The original DAO listing failure was not reproduced as a backend-only failure and remains attributable to the frontend proxy configuration described in the incident context. A separate backend regression was identified in the dependency declaration for the public API: the API still sends requests through RabbitMQ in several controllers, but `NEED_CONNECTIONS` declared only MongoDB. That change was corrected and covered by a regression test.

RabbitMQ connection logs and status also exposed the configured URI, which can contain credentials. The target is now sanitized before logging or returning status information.

Full unit, integration, Railway, Vercel, Atlas, RPC and proxy validation could not run in this workspace because dependencies are not installed (`ts-node` and `tsc` are unavailable) and no external platform credentials or frontend repository are present. These are explicit validation gaps, not pass results.

## Historical decision matrix

| Commit | Change/hypothesis | Decision |
|---|---|---|
| `e2b5fbca` | Schema typing for campaign rewards and gauge links | Retain pending schema fixture validation |
| `5023d1a`, `bc6e4183` | Mongo URI resolution, remote-environment guard, Docker/runtime diagnostics | Retain; verify Railway precedence and aliases externally |
| `9a273f65` | Guard malformed plugin/stage values in Mongo aggregations; remove RabbitMQ from API startup requirement | Keep aggregation guards; revert the connection removal because API routes use RabbitMQ |
| `d9e3ec95` | RabbitMQ Docker image | Retain only where deployment still uses the local broker |
| `cdabb474` | Filter advertised networks by configured networks | Retain pending production configuration comparison |
| `fb4402a1` | Wait for RabbitMQ retry instead of resolving early on connect failure | Retain pending broker failure-path tests |
| `c21fc960` | Reset stale indexer progress when DAO collection is empty near chain head | Retain pending Harmony/Mongo production evidence |
| `099f7474` | Advertise only networks with available providers | Retain pending RPC configuration validation |
| `5a4a17cc` | Add DAO/error diagnostics and guard malformed aggregation arrays | Retain diagnostics; review sensitive log fields |
| `c25d5f05`, `438f7d26` | Harden DAO aggregation input types and add aggregation error context | Retain; validate with explain and malformed fixtures |

## Implemented corrections

### Public API connection dependency

Evidence: `src/services/aragon-api/controllers/{contract,gauge,member,plugins,proposal}.ts` call `RabbitMQHelper.sendMessage`, while `src/services/aragon-api/index.ts` declared only `MONGODB`.

Correction: restore `[MONGODB, RABBITMQ]` in `NEED_CONNECTIONS` and add a service-level regression test.

Impact: the API cannot silently start without the broker required by its worker-backed routes. This does not change the HTTP contract.

### RabbitMQ credential exposure

Evidence: `src/modules/rabbitMQ.ts` logged and returned `config.RABBITMQ.URI` directly.

Correction: log and expose only protocol, host and vhost through `describeRabbitTarget`; credentials and query parameters are removed.

Impact: improves observability safety without changing connection behavior.

## Static contract findings

- Public API routes are mounted under `/v2`, with root fallback to v2/v1.
- Metrics is exposed by the admin API under `/metrics`; no `/v2/metrics` route exists in the inspected API router.
- Pagination types require `data` and `metadata { page, pageSize, totalPages, totalRecords }`.
- Empty-page helpers normalize empty responses to `totalPages: 1`, but every model implementation still requires runtime/fixture verification.
- No compression middleware is present in the backend source; compression behavior must be validated at Railway/Vercel/proxy boundaries.

## Configuration findings

The backend accepts Mongo aliases in this precedence order:

`MONGO_DB_URI`, `MONGODB_URI`, `MONGO_URI`, `MONGO_URL`, `MONGODB_URL`, `MONGO_PRIVATE_URL`, `MONGO_PUBLIC_URL`, `DATABASE_URL`.

The production container sets `NODE_ENV=production` and `ENVIRONMENT=production`, while the repository `.nvmrc` and Docker image target Node `22.18.0`; local execution used Node `24.14.1`. Railway variables, effective precedence, orphan variables, Atlas indexes, proxy headers and frontend commit remain externally unverified.

## Validation status

| Check | Result |
|---|---|
| Working tree before audit | Clean |
| Git baseline and history | Collected |
| Static route/config inspection | Completed |
| TypeScript compiler | Blocked: `tsc` unavailable |
| Unit tests | Blocked: `ts-node` unavailable |
| Railway/Vercel/Atlas/RPC | Blocked: external access/evidence unavailable |
| Code changes | Applied and diff-checked |

## Required continuation evidence

Before declaring the E2E sprint complete, run the repository install in the approved build environment and execute the targeted tests, then provide:

- stabilized frontend commit and captured requests;
- Railway deployment, environment names and redacted startup/request logs;
- direct-versus-proxy HTTP headers and payloads;
- Atlas index listings and `executionStats` for critical queries;
- Harmony indexer block/retry/queue state;
- RPC latency, fallback and rate-limit evidence.

## Prioritized follow-up

1. Critical: install locked dependencies in CI/build environment and run typecheck plus targeted unit tests.
2. Critical: validate RabbitMQ startup and worker-backed API routes in Railway.
3. Important: compare frontend commit contracts and confirm the metrics endpoint.
4. Important: run Atlas explain/index/performance checks and verify pagination on empty datasets.
5. Refactor: centralize redacted endpoint-target formatting for all external service logs.
6. Performance: measure proxy compression, serialization, Mongo latency, RPC latency and indexer lag.
