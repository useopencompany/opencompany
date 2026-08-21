import { ActionExecutionError } from "../actions/types";
import type { ManagedCapabilityMappedInput, ManagedCapabilityMonidActionSpec } from "./catalog";
import type { MonidInspection } from "./monid";

export function assertManagedCapabilityInspection(
  spec: ManagedCapabilityMonidActionSpec,
  mapped: ManagedCapabilityMappedInput,
  inspection: MonidInspection,
) {
  if (inspection.provider !== spec.provider || inspection.endpoint !== spec.endpoint) {
    throw new ActionExecutionError(
      "provider_error",
      "The capability endpoint no longer matches its reviewed contract.",
    );
  }
  if (!inspection.price || inspection.price.type !== spec.priceType) {
    throw new ActionExecutionError(
      "provider_error",
      "The capability pricing contract changed and requires review.",
    );
  }
  if (inspection.price.currency !== "USD") {
    throw new ActionExecutionError(
      "provider_error",
      "The capability currency contract changed and requires review.",
    );
  }
  const inspectionInput = inspectedProviderInput(spec, inspection.input);
  const inputContract = collectInspectionInputContract(inspectionInput);
  const schemaKeys = new Set(inputContract.fields.keys());
  const mappedKeys = Object.keys(mapped.providerInput);
  if (
    (mappedKeys.length > 0 && schemaKeys.size === 0) ||
    mappedKeys.some((key) => !schemaKeys.has(key)) ||
    [...inputContract.required].some((key) => !(key in mapped.providerInput)) ||
    mappedKeys.some(
      (key) =>
        !inspectionValueMatchesSchema(mapped.providerInput[key], inputContract.fields.get(key)),
    )
  ) {
    throw new ActionExecutionError(
      "provider_error",
      "The capability input contract changed and requires review.",
    );
  }
}

function inspectedProviderInput(spec: ManagedCapabilityMonidActionSpec, input: unknown) {
  if (!spec.inputLocation) return input;
  if (!isPlainRecord(input) || !isPlainRecord(input[spec.inputLocation])) {
    throw new ActionExecutionError(
      "provider_error",
      "The capability input contract changed and requires review.",
    );
  }
  return input[spec.inputLocation];
}

function collectInspectionInputContract(value: unknown) {
  const fields = new Map<string, unknown>();
  const required = new Set<string>();
  collectInspectionObject(value, fields, required);
  return { fields, required };
}

function collectInspectionObject(
  value: unknown,
  fields: Map<string, unknown>,
  required: Set<string>,
) {
  if (!isPlainRecord(value)) return;
  if (isPlainRecord(value.properties)) {
    const requiredFields = Array.isArray(value.required)
      ? new Set(value.required.filter((key): key is string => typeof key === "string"))
      : new Set<string>();
    for (const [key, descriptor] of Object.entries(value.properties)) {
      fields.set(key, descriptor);
      if (requiredFields.has(key)) required.add(key);
    }
  }
  if (typeof value.name === "string") {
    fields.set(value.name, value);
    if (value.required === true) required.add(value.name);
  }
  for (const [key, descriptor] of Object.entries(value)) {
    if (INSPECTION_SCHEMA_METADATA_KEYS.has(key)) continue;
    if (looksLikeInspectionField(descriptor)) {
      fields.set(key, descriptor);
      if (isPlainRecord(descriptor) && descriptor.required === true) {
        required.add(key);
      }
    }
    if (
      key === "schema" ||
      key === "body" ||
      key === "query" ||
      key === "queryParams" ||
      key === "pathParams" ||
      key === "parameters"
    ) {
      collectInspectionObject(descriptor, fields, required);
    }
  }
}

function looksLikeInspectionField(value: unknown) {
  if (typeof value === "string") return INSPECTION_VALUE_TYPES.has(value.toLowerCase());
  if (Array.isArray(value)) {
    return value.length === 1 && typeof value[0] === "string";
  }
  return (
    isPlainRecord(value) &&
    ("type" in value ||
      "description" in value ||
      "required" in value ||
      "enum" in value ||
      "items" in value)
  );
}

function inspectionValueMatchesSchema(value: unknown, descriptor: unknown): boolean {
  const type = inspectionDescriptorType(descriptor);
  if (!type) return true;
  if (
    isPlainRecord(descriptor) &&
    Array.isArray(descriptor.enum) &&
    !descriptor.enum.some((entry) => Object.is(entry, value))
  ) {
    return false;
  }
  if (type === "array") {
    if (!Array.isArray(value)) return false;
    const itemDescriptor = Array.isArray(descriptor)
      ? descriptor[0]
      : isPlainRecord(descriptor)
        ? descriptor.items
        : undefined;
    return itemDescriptor === undefined
      ? true
      : value.every((entry) => inspectionValueMatchesSchema(entry, itemDescriptor));
  }
  if (type === "object") return isPlainRecord(value);
  if (type === "string") return typeof value === "string";
  if (type === "integer") return Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  return true;
}

function inspectionDescriptorType(descriptor: unknown) {
  if (typeof descriptor === "string") return descriptor.toLowerCase();
  if (Array.isArray(descriptor)) return "array";
  if (!isPlainRecord(descriptor)) return null;
  if (typeof descriptor.type === "string") return descriptor.type.toLowerCase();
  return Array.isArray(descriptor.items) || isPlainRecord(descriptor.items) ? "array" : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const INSPECTION_VALUE_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "number",
  "object",
  "string",
]);
const INSPECTION_SCHEMA_METADATA_KEYS = new Set([
  "bodyType",
  "default",
  "description",
  "enum",
  "example",
  "format",
  "items",
  "name",
  "properties",
  "required",
  "title",
  "type",
]);
