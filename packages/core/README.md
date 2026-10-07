# @kavach/core

Pure TypeScript core for Dravika. It contains the wire schemas, PII detectors,
the policy engine, the vault, the egress gate and DOM/vision fusion.

This package uses **no browser APIs**. The extension and the planner server
both import it, so the client and the server validate against the same rules.

## Entry points

Import from the subpath you need instead of the package root:

| Import                          | What it provides                                                   |
| ------------------------------- | ------------------------------------------------------------------ |
| `@kavach/core`                  | Re-exports `./schema`                                              |
| `@kavach/core/schema`           | zod schemas for PII classes, the context packet and action plans   |
| `@kavach/core/schema/fixtures`  | `fixturePacket()`, a valid packet for tests                        |
| `@kavach/core/detectors`        | Checksums, Indian ID validators, the recognizer registry           |
| `@kavach/core/policy`           | `PolicyEngine`: raw regions in, sanitized scene elements out       |
| `@kavach/core/vault`            | `Vault`: in-memory map from placeholder tokens to real values      |
| `@kavach/core/gate`             | `EgressGate`: the only path a packet can take to the network       |
| `@kavach/core/fusion`           | Coordinate conversion, IoU, and DOM-to-vision region matching      |
| `@kavach/core/prompt`           | `extractPromptAnswers()`: matches task-prompt values to form fields |

## Modules

### schema/

- `pii.ts` lists every PII class (`AADHAAR`, `PAN`, `EMAIL`, `FACE`, ...) with
  its severity (`invariant`, `high` or `medium`). It also defines the
  placeholder token format, such as `PII:AADHAAR#1`, and the legend text
  the planner is shown.
- `scp.ts` defines the Sanitized Context Packet (`dravika.scp/1.0`): privacy
  mode, origin class, scene elements, boxes and states.
- `plan.ts` defines the Action Plan (`dravika.plan/1.0`) and its verbs
  (`click`, `type`, `select`, ...). `guardPlanAgainstPacket()` is the output
  guard that the client and the server share. A plan that fails any check
  is discarded whole and never partly executed.

### detectors/

- `checksums.ts` has the Verhoeff (Aadhaar), Luhn (cards) and GSTIN check
  characters. A checksum turns a noisy pattern match into a near-certain
  identification.
- `indian.ts` has a validator for each Indian identifier. Each validator
  reports a strength of `checksum`, `structure` or `format`.
- `recognizers.ts` is a Presidio-style registry of small recognizers.
  Context words near a span raise its confidence. `defaultRegistry()`
  builds the standard suite.

### policy/

`PolicyEngine` does not ask "is this PII?". It asks "can this region be
positively explained as safe?" and masks the region when the answer is no.
It returns sanitized elements, the redaction legend and a summary.

### vault/

The real values are held here and nowhere else after detection.

- Values stay in memory only. The vault never touches storage or the network.
- The same value and class in one session always gets the same token.
- Ordinals are assigned per session in discovery order, so a token cannot be
  matched across sessions.
- There is a hard entry cap (256 by default). When it is full, minting
  throws `VaultFullError` and the caller must redact without a token.
- Entries expire after a TTL (30 minutes by default).

### gate/

`EgressGate` checks every outgoing packet in this fixed order:

```
validate -> tripwire -> vault scan -> caps -> receipt -> send -> guard
```

The receipt is written before the send, so a record exists even if the
network fails, and blocked requests get a receipt too. The transport is
injected, which keeps network code out of this package. The repo-level
`npm run check:egress` enforces that rule.

### fusion/

Fusion matches vision detections to DOM and accessibility regions. Any
pixel region that structure cannot explain is flagged as unexplained, and
the policy engine masks it. All boxes are converted into working-image space
by one tested set of functions (`cssToImage`, `deviceToImage`) before they
are compared.

## Scripts

```
npm test -w @kavach/core        # vitest
npm run typecheck -w @kavach/core
```
