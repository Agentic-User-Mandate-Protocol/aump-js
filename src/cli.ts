#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";

import {
  evaluateAction,
  parseDate,
  validateBridge,
  validateEvidenceEvent,
  validateSchema,
} from "./index.js";

type JsonObject = Record<string, any>;

function main(argv: string[]): number {
  const [command, ...args] = argv;
  try {
    if (!command || command === "--help" || command === "-h") {
      help();
      return 0;
    }
    if (command === "validate") return validate(args);
    if (command === "validate-evidence") return validateEvidence(args);
    if (command === "validate-bridge") return validateBridgeCommand(args);
    if (command === "evaluate-action") return evaluate(args);
    throw new Error(`unknown command ${command}`);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
}

function validate(args: string[]): number {
  const [schemaName, path] = args;
  if (!schemaName || !path) {
    throw new Error("usage: aump validate <schema> <path>");
  }
  if (!isSchemaName(schemaName)) {
    throw new Error(
      "schema must be mandate, profile, action-evaluation, or evidence-event",
    );
  }
  const errors = validateSchema(schemaName, readJson(path));
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`${error}\n`);
    return 1;
  }
  return 0;
}

function validateEvidence(args: string[]): number {
  const options = parseOptions(args);
  const mandatePath = requireOption(options, "mandate");
  const eventPath = requireOption(options, "event");
  const now = parseDate(options.now ?? "2026-04-25T18:00:00Z");
  const result = validateEvidenceEvent(
    readJson(mandatePath),
    readJson(eventPath),
    { now },
  );
  writeJson(result);
  return result.valid ? 0 : 1;
}

function validateBridgeCommand(args: string[]): number {
  const [bridgeType, path] = args;
  if (!bridgeType || !path) {
    throw new Error("usage: aump validate-bridge <bridge_type> <path>");
  }
  if (!isBridgeType(bridgeType)) {
    throw new Error("unknown bridge_type");
  }
  const result = validateBridge(readJson(path), bridgeType);
  writeJson(result);
  return result.valid ? 0 : 1;
}

function evaluate(args: string[]): number {
  const options = parseOptions(args);
  const mandatePath = requireOption(options, "mandate");
  const actionPath = requireOption(options, "action");
  const context = options.context ? readJson(options.context) : {};
  const result = evaluateAction(readJson(mandatePath), readJson(actionPath), {
    now: parseDate(options.now ?? "2026-04-25T18:00:00Z"),
    context,
  });
  writeJson(result);
  return 0;
}

function parseOptions(args: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    options[name] = value;
    index += 1;
  }
  return options;
}

function requireOption(options: Record<string, string>, name: string): string {
  const value = options[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function isSchemaName(
  value: string,
): value is "mandate" | "profile" | "action-evaluation" | "evidence-event" {
  return ["mandate", "profile", "action-evaluation", "evidence-event"].includes(
    value,
  );
}

function isBridgeType(
  value: string,
): value is
  | "mcp_meta"
  | "mcp_tool"
  | "a2a_extension"
  | "a2a_message"
  | "ucp_reference" {
  return [
    "mcp_meta",
    "mcp_tool",
    "a2a_extension",
    "a2a_message",
    "ucp_reference",
  ].includes(value);
}

function help(): void {
  process.stdout.write(`AUMP TypeScript CLI

Usage:
  aump validate <mandate|profile|action-evaluation|evidence-event> <path>
  aump validate-evidence --mandate <path> --event <path> [--now <date-time>]
  aump validate-bridge <bridge_type> <path>
  aump evaluate-action --mandate <path> --action <path> [--context <path>] [--now <date-time>]
`);
}

process.exitCode = main(process.argv.slice(2));
