import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  evaluateAction,
  parseDate,
  validateBridge,
  validateEvidenceEvent,
  validateMandateSemantics,
  validateSchema,
} from "../dist/index.js";

const workspaceFixtures = join(process.cwd(), "..", "conformance", "fixtures");
const snapshotFixtures = join(process.cwd(), "tests", "fixtures", "conformance");
const fixtures = existsSync(join(workspaceFixtures, "manifest.json"))
  ? workspaceFixtures
  : snapshotFixtures;

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("bundled schemas validate conformance examples", () => {
  const mandate = loadJson(
    join(fixtures, "mandates", "marketplace-buyer.valid.json"),
  );
  const profile = loadJson(join(fixtures, "profiles", "aump-profile.valid.json"));
  const evidence = loadJson(join(fixtures, "events", "deal-accepted.valid.json"));
  assert.deepEqual(validateSchema("mandate", mandate), []);
  assert.deepEqual(validateSchema("profile", profile), []);
  assert.deepEqual(validateSchema("evidence-event", evidence), []);
});

test("mandate lifecycle matches conformance cases", () => {
  const now = parseDate("2026-04-25T18:00:00Z");
  const active = loadJson(join(fixtures, "mandates", "marketplace-buyer.valid.json"));
  const expired = loadJson(
    join(fixtures, "mandates", "marketplace-buyer.expired.json"),
  );
  assert.equal(validateMandateSemantics(active, { now }).valid, true);
  assert.deepEqual(validateMandateSemantics(expired, { now }).reason_codes, [
    "mandate_expired",
  ]);
});

test("action evaluation matches conformance decisions", () => {
  const now = parseDate("2026-04-25T18:00:00Z");
  const mandate = loadJson(
    join(fixtures, "mandates", "marketplace-buyer.valid.json"),
  );
  const allowed = evaluateAction(
    mandate,
    loadJson(join(fixtures, "actions", "accept-ping-pong.allowed.json")),
    { now },
  );
  assert.equal(allowed.decision, "allowed");

  const denied = evaluateAction(
    mandate,
    loadJson(join(fixtures, "actions", "accept-over-budget.denied.json")),
    { now },
  );
  assert.equal(denied.decision, "denied");
  assert.ok(denied.reason_codes.includes("price_above_budget"));
});

test("bridge validation matches conformance bridge fixtures", () => {
  const mcp = loadJson(
    join(fixtures, "bridges", "mcp-evaluate-action-tool-call.valid.json"),
  );
  const mcpTool = loadJson(
    join(fixtures, "bridges", "mcp-evaluate-action-tool.valid.json"),
  );
  const a2a = loadJson(
    join(fixtures, "bridges", "a2a-message-mandate-ref.valid.json"),
  );
  const ucpInvalid = loadJson(
    join(fixtures, "bridges", "ucp-full-mandate.invalid.json"),
  );
  assert.equal(validateBridge(mcp, "mcp_meta").valid, true);
  assert.equal(validateBridge(mcpTool, "mcp_tool").valid, true);
  assert.equal(validateBridge(a2a, "a2a_message").valid, true);
  assert.equal(validateBridge(ucpInvalid, "ucp_reference").valid, false);
});

test("evidence semantics match conformance fixtures", () => {
  const now = parseDate("2026-04-25T18:00:00Z");
  const mandate = loadJson(
    join(fixtures, "mandates", "marketplace-buyer.valid.json"),
  );
  const valid = loadJson(join(fixtures, "events", "deal-accepted.valid.json"));
  const privateLeak = loadJson(
    join(fixtures, "events", "deal-accepted.private-leak.invalid.json"),
  );
  assert.equal(validateEvidenceEvent(mandate, valid, { now }).valid, true);
  assert.deepEqual(
    validateEvidenceEvent(mandate, privateLeak, { now }).reason_codes,
    ["evidence_private_field_leak"],
  );
});
