# aump-js

TypeScript SDK and validator for the Agentic User Mandate Protocol.

This package provides:

- bundled AUMP v0.1 JSON Schemas;
- mandate lifecycle validation;
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

The tests run against the sibling `conformance/fixtures` corpus.

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
