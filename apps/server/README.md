# @kavach/server

The Dravika planner service. It receives a Sanitized Context Packet, checks
it again, plans against the redaction legend and guards its own output
before it replies.

It listens on `127.0.0.1` only (port `8787` by default, set with `PORT`).

## Endpoints

| Method | Path      | Purpose                                                    |
| ------ | --------- | ---------------------------------------------------------- |
| GET    | `/health` | Planner metadata only. It never includes task or page data. |
| POST   | `/plan`   | Takes a Sanitized Context Packet and returns an Action Plan. |

Everything else returns `404`.

### `/plan` pipeline

```
read body (4 MiB cap)
  -> JSON parse                 400 on failure
  -> SanitizedContextPacket     422 on schema failure
  -> PII re-scan                422 if any strong detection
  -> heuristic plan
  -> optional configured model  falls back to the heuristic on any problem
  -> output guard               500 if the final plan fails the guard
  -> 200 Action Plan
```

The server does not trust the client's sanitization. `rescan.ts` re-runs the
full detector suite over every string in the packet. A hit at or above 0.8
confidence means the client is broken or malicious, so the packet is
rejected and logged, never processed.

Error responses never echo parser or planner messages. A malformed response
could carry text taken from the page, and errors are not a safe data channel.

## Planners

### Heuristic (`planner/heuristic.ts`)

The deterministic Tier 0 planner uses no model and no network, so it works
fully offline. It decides from roles, states and placeholders only:

1. If a required form field is empty, ask the user for it. The server never
   knows real values, so `user_prompt` is the only way to get them.
2. If every required field is filled, click the primary action. When the
   action is flagged as risky, ask for confirmation first.
3. Otherwise report `done` or ask for more context.

### Configured model (`planner/remote.ts`)

This is an optional OpenAI-compatible chat endpoint, set up through
environment variables (see [`.env.example`](../../.env.example)):

| Variable              | Default     | Notes                                          |
| --------------------- | ----------- | ---------------------------------------------- |
| `PLANNER_ENDPOINT`    | (unset)     | Leave unset for the heuristic planner only     |
| `PLANNER_MODEL`       | `default`   | Model name sent to the endpoint                |
| `PLANNER_API_KEY`     | (unset)     | Sent as a bearer token when set                |
| `PLANNER_MODE`        | `auto`      | `heuristic`, `auto` or `model`                 |
| `PLANNER_TEMPERATURE` | `0`         | Must be between 0 and 2                        |
| `PLANNER_TIMEOUT_MS`  | `30000`     | Must be positive                               |

When the model is consulted:

- **heuristic**: never.
- **auto**: only on non-form pages, when the heuristic plan is not simple or
  finishes with nothing to do.
- **model**: always. On form pages the model only advises. Its first step
  must match the local deterministic step, and any extra steps are dropped,
  so the model cannot trigger an early submit.

If the model's plan fails the guard, comes back empty when the heuristic has
steps, or disagrees on a form page, the server logs a `planner_fallback`
event and uses the heuristic plan instead.

## Audit log

Each request produces structured log lines (`packet_received`,
`packet_rejected`, `planner_fallback`, `plan_rejected`, `plan_sent`,
`request_error`). They hold counts, classes, element IDs and a hashed packet
key, never field values.

## Development

```
npm run dev -w @kavach/server     # tsx src/main.ts
npm test -w @kavach/server        # unit, e2e, red-team and form-advisory tests
npm run typecheck -w @kavach/server
```

From the repo root, `npm run dev` builds the extension and starts this
server through `tools/start-local.mjs`.
