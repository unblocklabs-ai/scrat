export type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
export function buildConfig(defaults: Json, overrides: Json, path = ""): Json {
  const merged: Json = { ...defaults }, open = path === "workspace.environment." || path.startsWith("providers.");
  for (const [key, value] of Object.entries(overrides)) {
    const where = path + key, base = defaults[key];
    if (key === "__proto__" || (!open && !Object.hasOwn(defaults, key))) throw new Error(`Unknown setting in scrat.local.json: ${where}`);
    if (!isObject(base) || (value === null && where.startsWith("workspace"))) merged[key] = value;
    else if (isObject(value)) merged[key] = buildConfig(base, value, where + ".");
    else throw new Error(`Setting in scrat.local.json must be an object${where.startsWith("workspace") ? " or null" : ""}: ${where}`);
  }
  return merged;
}
