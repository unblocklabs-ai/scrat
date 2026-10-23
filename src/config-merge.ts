export type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
export function buildConfig(defaults: Json, overrides: Json, path = ""): Json {
  const merged: Json = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "__proto__") throw new Error(`Unknown setting in scrat.local.json: ${path + key}`);
    const base = defaults[key];
    merged[key] = isObject(base) && isObject(value) ? buildConfig(base, value, `${path}${key}.`) : value;
  }
  return merged;
}
