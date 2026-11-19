// Bounded, non-throwing rendering of a decoded value for an error message.
// Values reach diagnostics straight from an artifact (JSON, plist), so the
// rendering must survive anything a decoder can produce: a BigInt, deep
// nesting, a huge string or container, a cycle. It renders JSON-like text and
// stops once the budget is spent; it never calls JSON.stringify on the value.

const DEFAULT_MAX_LENGTH = 80;
const MAX_DEPTH = 4;

export function describeValue(value: unknown, maxLength = DEFAULT_MAX_LENGTH): string {
  if (value === undefined) {
    return "nothing";
  }
  let text: string;
  try {
    text = render(value, maxLength + 1);
  } catch {
    text = `<${typeof value}>`;
  }
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
}

function render(root: unknown, budget: number): string {
  let out = "";
  const active = new Set<object>();

  const emit = (part: string): boolean => {
    out += part.length > budget ? part.slice(0, budget) : part;
    return out.length < budget;
  };

  const walk = (value: unknown, depth: number): boolean => {
    switch (typeof value) {
      case "string":
        // JSON.stringify of a string cannot throw; slice first so a long
        // string costs no more than the budget.
        return emit(JSON.stringify(value.length > budget ? value.slice(0, budget) : value));
      case "number":
      case "boolean":
        return emit(String(value));
      case "bigint":
        return emit(`${value.toString()}n`);
      case "undefined":
        return emit("undefined");
      case "symbol":
      case "function":
        return emit(`<${typeof value}>`);
    }
    if (value === null) {
      return emit("null");
    }
    const object = value as object;
    if (object instanceof Uint8Array) {
      return emit(`<${object.length} bytes>`);
    }
    if (active.has(object)) {
      return emit("<cycle>");
    }
    const isArray = Array.isArray(object);
    if (depth >= MAX_DEPTH) {
      return emit(isArray ? "[...]" : "{...}");
    }

    active.add(object);
    try {
      if (isArray) {
        if (!emit("[")) return false;
        const array = object as unknown[];
        for (let index = 0; index < array.length; index += 1) {
          if (index > 0 && !emit(",")) return false;
          if (!walk(array[index], depth + 1)) return false;
        }
        return emit("]");
      }

      if (!emit("{")) return false;
      let first = true;
      const member = (key: string, child: unknown): boolean => {
        if (!first && !emit(",")) return false;
        first = false;
        return emit(`${JSON.stringify(key.length > budget ? key.slice(0, budget) : key)}:`) && walk(child, depth + 1);
      };
      if (object instanceof Map) {
        for (const [key, child] of object) {
          if (!member(String(key), child)) return false;
        }
      } else {
        for (const key in object) {
          if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
          if (!member(key, (object as Record<string, unknown>)[key])) return false;
        }
      }
      return emit("}");
    } finally {
      active.delete(object);
    }
  };

  walk(root, 0);
  return out;
}
