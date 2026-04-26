# aump-js

TypeScript SDK and validator for the Agentic User Mandate Protocol.

This package provides:

- bundled AUMP v0.1 JSON Schemas;
- mandate lifecycle validation;
- evidence event schema validation;
- evidence event semantic validation against mandate references, retention
  policy, and required event policy;
- deterministic action evaluation;
- MCP, A2A, and UCP/AP2 bridge validation helpers.

## Install

```bash
npm install
```

## Build

```bash
npm run build
```

## Test

The tests prefer the sibling `conformance/fixtures` corpus when this workspace
is cloned end to end. CI falls back to the pinned
`tests/fixtures/conformance` snapshot so this repo can validate itself.

```bash
npm test
```

## Usage

```ts
import { evaluateAction, parseDate } from "@agentic-user-mandate-protocol/aump";

const result = evaluateAction(mandate, action, {
  now: parseDate("2026-04-25T18:00:00Z"),
});

if (result.decision === "requires_escalation") {
  // pause autonomous commitment and ask through trusted UI
}
```
