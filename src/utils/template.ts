/**
 * Template Engine
 * Variable interpolation for journey configurations
 */

/**
 * Interpolate variables in a template string
 * Supports {{variable}} and {{nested.path}} syntax
 */
export function interpolate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    const trimmedPath = path.trim();
    const value = getNestedValue(context, trimmedPath);

    if (value === undefined) {
      // Return original placeholder if value not found
      return match;
    }

    return String(value);
  });
}

/**
 * Recursively interpolate all string values in an object
 */
export function interpolateObject<T>(obj: T, context: Record<string, unknown>): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return interpolate(obj, context) as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => interpolateObject(item, context)) as T;
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateObject(value, context);
    }
    return result as T;
  }

  return obj;
}

/**
 * Get a nested value from an object using dot notation
 * e.g., getNestedValue({ user: { name: 'John' } }, 'user.name') => 'John'
 */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (typeof current !== 'object') {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Set a nested value in an object using dot notation
 */
export function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const parts = path.split('.');
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
}

/**
 * Extract all variable references from a template string
 * Returns array of variable paths like ['user.name', 'env.API_URL']
 */
export function extractVariableRefs(template: string): string[] {
  const refs: string[] = [];
  const regex = /\{\{([^}]+)\}\}/g;
  let match;

  while ((match = regex.exec(template)) !== null) {
    refs.push(match[1].trim());
  }

  return refs;
}

/**
 * Extract all variable references from an object recursively
 */
export function extractAllVariableRefs(obj: unknown): string[] {
  const refs = new Set<string>();

  function traverse(value: unknown): void {
    if (typeof value === 'string') {
      for (const ref of extractVariableRefs(value)) {
        refs.add(ref);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        traverse(item);
      }
    } else if (value !== null && typeof value === 'object') {
      for (const key of Object.values(value)) {
        traverse(key);
      }
    }
  }

  traverse(obj);
  return Array.from(refs);
}

/**
 * Check if a string contains any variable references
 */
export function hasVariableRefs(str: string): boolean {
  return /\{\{[^}]+\}\}/.test(str);
}

/**
 * Build a context object from multiple sources
 * Later sources override earlier ones
 */
export function buildContext(...sources: Record<string, unknown>[]): Record<string, unknown> {
  const context: Record<string, unknown> = {};

  for (const source of sources) {
    deepMerge(context, source);
  }

  return context;
}

/**
 * Deep merge two objects
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      key in target &&
      target[key] !== null &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      deepMerge(
        target[key] as Record<string, unknown>,
        value as Record<string, unknown>
      );
    } else {
      target[key] = value;
    }
  }
}
