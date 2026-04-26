import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import type { ErrorObject } from "ajv";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;

export type Decision = "allowed" | "requires_escalation" | "denied";

export type EvaluationResponse = {
  aump: {
    version: string;
    type: "action_evaluation_response";
  };
  mandate_ref: {
    id: string;
    version: string;
  };
  decision: Decision;
  reason_codes: string[];
  paths: string[];
  summary: string;
};

export const AUMP_META_ID =
  "org.agentic-user-mandate-protocol/aump_mandate_id";
export const AUMP_META_HASH =
  "org.agentic-user-mandate-protocol/aump_mandate_hash";
export const AUMP_META_VERSION =
  "org.agentic-user-mandate-protocol/aump_version";
export const AUMP_A2A_EXTENSION_URI =
  "https://agentic-user-mandate-protocol.github.io/spec/bindings/a2a/v0.1";

const COMMITMENT_ACTIONS = new Set([
  "accept_deal",
  "complete_checkout",
  "place_order",
  "create_ap2_payment_mandate",
]);

const META_KEY_RE =
  /^([A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)*\/)?[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;

export function parseDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid date-time: ${value}`);
  }
  return date;
}

export function mandateHash(mandate: Record<string, unknown>): string {
  return `sha256-${createHash("sha256")
    .update(stableStringify(mandate))
    .digest("hex")}`;
}

export function validateMandateSemantics(
  mandate: Record<string, any>,
  options: { now: Date },
): { valid: boolean; reason_codes: string[]; paths: string[] } {
  const reasonCodes: string[] = [];
  const paths: string[] = [];

  if (mandate.status !== "active") {
    reasonCodes.push("mandate_inactive");
    paths.push("$.status");
  }

  if (typeof mandate.expires_at === "string") {
    if (parseDate(mandate.expires_at).getTime() <= options.now.getTime()) {
      reasonCodes.push("mandate_expired");
      paths.push("$.expires_at");
    }
  }

  if (
    mandate.authority?.mode === "delegated" &&
    !hasObjectiveBound(mandate)
  ) {
    reasonCodes.push("scope_violation");
    paths.push("$.authority");
  }

  return {
    valid: reasonCodes.length === 0,
    reason_codes: reasonCodes,
    paths,
  };
}

export function evaluateAction(
  mandate: Record<string, any>,
  action: Record<string, any>,
  options: { now: Date; context?: Record<string, any> },
): EvaluationResponse {
  const context = options.context ?? {};
  const deniedReasons: string[] = [];
  const deniedPaths: string[] = [];
  const escalationReasons: string[] = [];
  const escalationPaths: string[] = [];

  const mandateResult = validateMandateSemantics(mandate, { now: options.now });
  if (!mandateResult.valid) {
    deniedReasons.push(...mandateResult.reason_codes);
    deniedPaths.push(...mandateResult.paths);
  }

  const authority = mandate.authority ?? {};
  const permissions = new Set(authority.permissions ?? []);
  if (!permissions.has(action.type)) {
    deniedReasons.push("scope_violation");
    deniedPaths.push("$.authority.permissions");
  }

  const prohibited = new Set(authority.prohibited_actions ?? []);
  if (prohibited.has(action.type)) {
    deniedReasons.push("scope_violation");
    deniedPaths.push("$.authority.prohibited_actions");
  }

  evaluateAmount(mandate, action, deniedReasons, deniedPaths);
  evaluateDisclosures(mandate, action, deniedReasons, deniedPaths);
  evaluateEscalation(
    mandate,
    action,
    context,
    escalationReasons,
    escalationPaths,
  );

  let decision: Decision;
  let reasonCodes: string[];
  let paths: string[];
  if (deniedReasons.length > 0) {
    decision = "denied";
    reasonCodes = stableUnique(deniedReasons);
    paths = stableUnique(deniedPaths);
  } else if (escalationReasons.length > 0) {
    decision = "requires_escalation";
    reasonCodes = stableUnique(escalationReasons);
    paths = stableUnique(escalationPaths);
  } else {
    decision = "allowed";
    reasonCodes = [];
    paths = [];
  }

  return {
    aump: {
      version: mandate.aump?.version ?? "0.1.0",
      type: "action_evaluation_response",
    },
    mandate_ref: {
      id: mandate.id ?? "",
      version: mandate.aump?.version ?? "0.1.0",
    },
    decision,
    reason_codes: reasonCodes,
    paths,
    summary: summary(decision, reasonCodes),
  };
}

export function validateSchema(
  schemaName: "mandate" | "profile" | "action-evaluation",
  payload: unknown,
): string[] {
  const schemaFile = {
    mandate: "mandate.schema.json",
    profile: "profile.schema.json",
    "action-evaluation": "action-evaluation.schema.json",
  }[schemaName];
  const schemaPath = fileURLToPath(new URL(`./schemas/${schemaFile}`, import.meta.url));
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (validate(payload)) return [];
  return (validate.errors ?? []).map((error: ErrorObject) => {
    const path = error.instancePath ? `$${error.instancePath}` : "$";
    return `${path}: ${error.message ?? "schema error"}`;
  });
}

export function validateBridge(
  payload: Record<string, any>,
  bridgeType:
    | "mcp_meta"
    | "mcp_tool"
    | "a2a_extension"
    | "a2a_message"
    | "ucp_reference",
): { valid: boolean; errors: string[] } {
  if (bridgeType === "mcp_meta") return validateMcpMeta(payload);
  if (bridgeType === "mcp_tool") return validateMcpTool(payload);
  if (bridgeType === "a2a_extension") return validateA2aExtension(payload);
  if (bridgeType === "a2a_message") return validateA2aMessage(payload);
  return validateUcpReference(payload);
}

function hasObjectiveBound(mandate: Record<string, any>): boolean {
  const authority = mandate.authority ?? {};
  const purpose = mandate.purpose ?? {};
  return Boolean(
    authority.budget ||
      authority.prohibited_actions?.length ||
      purpose.allowed_categories?.length ||
      purpose.allowed_counterparties?.length ||
      purpose.excluded_counterparties?.length,
  );
}

function evaluateAmount(
  mandate: Record<string, any>,
  action: Record<string, any>,
  deniedReasons: string[],
  deniedPaths: string[],
): void {
  if (!action.amount) return;
  const budget = mandate.authority?.budget;
  if (!budget) {
    deniedReasons.push("scope_violation");
    deniedPaths.push("$.authority.budget");
    return;
  }
  if (action.amount.currency !== budget.currency) {
    deniedReasons.push("hard_constraint_violation", "currency_mismatch");
    deniedPaths.push("$.authority.budget.currency");
  }
  if (
    Number.isInteger(action.amount.total_minor) &&
    Number.isInteger(budget.max_total_minor) &&
    action.amount.total_minor > budget.max_total_minor
  ) {
    deniedReasons.push("hard_constraint_violation", "price_above_budget");
    deniedPaths.push("$.authority.budget.max_total_minor");
  }
}

function evaluateDisclosures(
  mandate: Record<string, any>,
  action: Record<string, any>,
  deniedReasons: string[],
  deniedPaths: string[],
): void {
  if (!Array.isArray(action.disclosures)) return;
  const disclosure = mandate.disclosure ?? {};
  const allowed = new Set((disclosure.allowed ?? []).map((rule: any) => rule.field));
  const prohibited = new Set(
    (disclosure.prohibited ?? []).map((rule: any) => rule.field),
  );
  for (const [index, item] of action.disclosures.entries()) {
    const field = item.field;
    const shouldDeny =
      prohibited.has(field) ||
      isProtectedField(mandate, field) ||
      (disclosure.default === "deny" && !allowed.has(field));
    if (shouldDeny) {
      deniedReasons.push("disclosure_denied");
      deniedPaths.push(`$.proposed_action.disclosures[${index}].field`);
    }
  }
}

function evaluateEscalation(
  mandate: Record<string, any>,
  action: Record<string, any>,
  context: Record<string, any>,
  escalationReasons: string[],
  escalationPaths: string[],
): void {
  const escalation = mandate.escalation ?? {};
  const required = new Set(escalation.required_conditions ?? []);
  const active = new Set(context.conditions ?? []);
  if ([...required].some((condition) => active.has(condition))) {
    escalationReasons.push("escalation_required");
    escalationPaths.push("$.escalation.required_conditions");
  }
  if (
    typeof escalation.confidence_threshold === "number" &&
    typeof context.confidence === "number" &&
    context.confidence < escalation.confidence_threshold
  ) {
    escalationReasons.push("escalation_required", "confidence_below_threshold");
    escalationPaths.push("$.escalation.confidence_threshold");
  }
  const authority = mandate.authority ?? {};
  const isCommitment = Boolean(action.commitment) || COMMITMENT_ACTIONS.has(action.type);
  if (authority.mode === "supervised" && isCommitment) {
    escalationReasons.push("escalation_required");
    escalationPaths.push("$.authority.mode");
  }
  if (
    authority.requires_trusted_ui_for_commitment &&
    isCommitment &&
    !context.trusted_ui_approved
  ) {
    escalationReasons.push("escalation_required");
    escalationPaths.push("$.authority.requires_trusted_ui_for_commitment");
  }
}

function isProtectedField(mandate: Record<string, any>, field: unknown): boolean {
  if (typeof field !== "string") return false;
  for (const protectedField of mandate.negotiation?.protected_fields ?? []) {
    if (field === protectedField || field.endsWith(`.${protectedField}`)) {
      return true;
    }
  }
  return field === "preferences.private_notes" || field.endsWith(".private_notes");
}

function validateMcpMeta(payload: Record<string, any>): {
  valid: boolean;
  errors: string[];
} {
  const meta = findMcpRequestMeta(payload);
  const errors: string[] = [];
  if (!meta) return { valid: false, errors: ["missing MCP _meta object"] };
  for (const key of Object.keys(meta)) {
    if (!META_KEY_RE.test(key)) errors.push(`invalid MCP _meta key ${key}`);
    const prefix = key.includes("/") ? key.split("/", 1)[0] : "";
    const labels = prefix.split(".");
    if (labels.length >= 2 && ["mcp", "modelcontextprotocol"].includes(labels[1])) {
      errors.push(`reserved MCP _meta prefix ${prefix}`);
    }
  }
  if (!meta[AUMP_META_ID]) errors.push(`missing ${AUMP_META_ID}`);
  if (!meta[AUMP_META_HASH]) errors.push(`missing ${AUMP_META_HASH}`);
  if (!meta[AUMP_META_VERSION]) errors.push(`missing ${AUMP_META_VERSION}`);
  return { valid: errors.length === 0, errors };
}

function validateMcpTool(payload: Record<string, any>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (payload.name !== "aump.evaluate_action") {
    errors.push("MCP tool name must be aump.evaluate_action");
  }
  for (const field of ["inputSchema", "outputSchema"]) {
    if (!payload[field] || typeof payload[field] !== "object") {
      errors.push(`missing ${field} object`);
    }
  }

  const annotations = payload.annotations;
  if (!annotations || typeof annotations !== "object") {
    errors.push("missing annotations object");
  } else {
    if (annotations.readOnlyHint !== true) {
      errors.push("aump.evaluate_action must be readOnlyHint=true");
    }
    if (annotations.destructiveHint !== false) {
      errors.push("aump.evaluate_action must be destructiveHint=false");
    }
    if (annotations.idempotentHint !== true) {
      errors.push("aump.evaluate_action must be idempotentHint=true");
    }
  }
  return { valid: errors.length === 0, errors };
}

function validateA2aExtension(payload: Record<string, any>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  for (const field of ["name", "version", "url"]) {
    if (!payload[field]) errors.push(`missing Agent Card ${field}`);
  }
  if (!Array.isArray(payload.skills) || payload.skills.length === 0) {
    errors.push("Agent Card must advertise at least one skill");
  }
  if (!Array.isArray(payload.defaultInputModes)) {
    errors.push("missing defaultInputModes array");
  }
  if (!Array.isArray(payload.defaultOutputModes)) {
    errors.push("missing defaultOutputModes array");
  }

  const extensions = payload.capabilities?.extensions;
  if (!Array.isArray(extensions)) {
    return { valid: false, errors: ["capabilities.extensions must be an array"] };
  }
  for (const extension of extensions) {
    if (extension?.uri !== AUMP_A2A_EXTENSION_URI) continue;
    if (extension.required !== false) {
      errors.push("AUMP A2A extension must be optional by default");
    }
    if (!extension.params?.versions?.includes("0.1.0")) {
      errors.push("AUMP A2A extension params.versions must include 0.1.0");
    }
    return { valid: errors.length === 0, errors };
  }
  errors.push("missing AUMP A2A AgentExtension declaration");
  return { valid: false, errors };
}

function validateA2aMessage(payload: Record<string, any>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const message =
    payload.message && typeof payload.message === "object" ? payload.message : payload;
  if (!message.messageId) errors.push("missing message.messageId");

  const activeExtensions = splitExtensionHeader(payload.headers?.["A2A-Extensions"]);
  if (!activeExtensions.has(AUMP_A2A_EXTENSION_URI)) {
    errors.push("missing A2A-Extensions activation for AUMP");
  }
  if (!Array.isArray(message.extensions) || !message.extensions.includes(AUMP_A2A_EXTENSION_URI)) {
    errors.push("missing message.extensions AUMP URI");
  }

  const metadata = message.metadata ?? {};
  const aumpMetadata = metadata[AUMP_A2A_EXTENSION_URI];
  if (!aumpMetadata || typeof aumpMetadata !== "object") {
    errors.push("missing extension-scoped AUMP message metadata");
    return { valid: false, errors };
  }
  if (aumpMetadata.mandate) {
    errors.push("A2A message must not embed full private AUMP mandate");
  }
  for (const field of ["mandate_id", "mandate_hash", "version"]) {
    if (!aumpMetadata[field]) errors.push(`missing A2A AUMP metadata ${field}`);
  }
  return { valid: errors.length === 0, errors };
}

function validateUcpReference(payload: Record<string, any>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const meta = payload.meta;
  if (!meta || typeof meta !== "object") {
    return { valid: false, errors: ["missing UCP meta object"] };
  }
  if (!meta["ucp-agent"]?.profile) {
    errors.push('missing meta["ucp-agent"].profile');
  }
  const aump = meta.aump;
  if (!aump || typeof aump !== "object") {
    errors.push("missing meta.aump reference object");
    return { valid: false, errors };
  }
  if (payload.ap2?.aump) {
    errors.push("AUMP references must not be placed under AP2 ap2 namespace");
  }
  if (aump.mandate) {
    errors.push("UCP/AP2 bridge must not embed full private AUMP mandate");
  }
  for (const field of ["mandate_id", "mandate_hash", "version"]) {
    if (!aump[field]) errors.push(`missing meta.aump.${field}`);
  }
  return { valid: errors.length === 0, errors };
}

function findMcpRequestMeta(payload: Record<string, any>): Record<string, any> | undefined {
  if (payload.params?._meta && typeof payload.params._meta === "object") {
    return payload.params._meta;
  }
  if (payload._meta && typeof payload._meta === "object") return payload._meta;
  return undefined;
}

function splitExtensionHeader(value: unknown): Set<string> {
  if (typeof value !== "string") return new Set();
  return new Set(value.split(",").map((part) => part.trim()).filter(Boolean));
}

function stableUnique(values: string[]): string[] {
  return [...new Set(values)];
}

function summary(decision: Decision, reasonCodes: string[]): string {
  if (decision === "allowed") return "The proposed action is allowed by the active mandate.";
  if (decision === "requires_escalation") {
    return "The proposed action requires trusted review before continuing.";
  }
  return `The proposed action is denied by mandate policy: ${reasonCodes.join(", ")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as any)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
