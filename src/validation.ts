import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

export function parseValue<T extends TSchema>(
  schema: T,
  value: unknown,
  message: string,
): Static<T> {
  try {
    return Value.Parse(schema, value);
  } catch (cause) {
    const error = Value.Errors(schema, value)[0];
    const detail = error ? `: ${error.instancePath || "/"} ${error.message}` : "";
    throw new Error(`${message}${detail}`, { cause });
  }
}
