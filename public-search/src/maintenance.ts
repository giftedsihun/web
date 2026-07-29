export class MaintenanceInputError extends Error {}

export function normalizeRetentionInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MaintenanceInputError("Retention settings must be an object.");
  const input = value as { before?: unknown; deleteDocuments?: unknown; dryRun?: unknown };
  if (typeof input.before !== "string" || !input.before.trim() || Number.isNaN(Date.parse(input.before))) throw new MaintenanceInputError("before must be a valid ISO date.");
  if (input.deleteDocuments !== undefined && typeof input.deleteDocuments !== "boolean") throw new MaintenanceInputError("deleteDocuments must be a boolean.");
  if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") throw new MaintenanceInputError("dryRun must be a boolean.");
  return { before: new Date(input.before).toISOString(), deleteDocuments: input.deleteDocuments === true, dryRun: input.dryRun !== false };
}
