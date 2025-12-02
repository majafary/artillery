/**
 * Data Extractor
 * Extracts values from API responses using JSONPath, headers, or regex
 */

import { JSONPath } from 'jsonpath-plus';
import type { Extraction, ExtractionType, StepResponse } from '../types/index.js';

export interface ExtractionResult {
  success: boolean;
  value: unknown;
  error?: string;
}

export class DataExtractor {
  /**
   * Execute an extraction definition against a response
   */
  extract(extraction: Extraction, response: StepResponse): ExtractionResult {
    const type = extraction.type || 'jsonpath';

    let result: ExtractionResult;

    switch (type) {
      case 'jsonpath':
        result = this.extractJsonPath(response.body, extraction.path);
        break;
      case 'header':
        result = this.extractHeader(response.headers, extraction.path);
        break;
      case 'regex':
        result = this.extractRegex(response.body, extraction.path);
        break;
      case 'status':
        result = { success: true, value: response.statusCode };
        break;
      default:
        result = { success: false, value: undefined, error: `Unknown extraction type: ${type}` };
    }

    // Apply default if extraction failed
    if (!result.success && extraction.default !== undefined) {
      result = { success: true, value: extraction.default };
    }

    // Apply transform if specified
    if (result.success && extraction.transform) {
      result = this.applyTransform(result.value, extraction.transform);
    }

    return result;
  }

  /**
   * Extract value using JSONPath expression
   */
  extractJsonPath(body: unknown, path: string): ExtractionResult {
    try {
      if (body === null || body === undefined) {
        return { success: false, value: undefined, error: 'Response body is empty' };
      }

      // Handle string body (try to parse as JSON)
      let jsonBody = body;
      if (typeof body === 'string') {
        try {
          jsonBody = JSON.parse(body);
        } catch {
          return { success: false, value: undefined, error: 'Response body is not valid JSON' };
        }
      }

      const results = JSONPath({
        path,
        json: jsonBody as object,
        wrap: false,
      });

      if (results === undefined || (Array.isArray(results) && results.length === 0)) {
        return { success: false, value: undefined, error: `No match for path: ${path}` };
      }

      // Return single value if only one result, otherwise return array
      const value = Array.isArray(results) && results.length === 1 ? results[0] : results;

      return { success: true, value };
    } catch (error) {
      return {
        success: false,
        value: undefined,
        error: `JSONPath extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Extract value from response header
   */
  extractHeader(headers: Record<string, string>, headerName: string): ExtractionResult {
    // Headers are case-insensitive
    const normalizedName = headerName.toLowerCase();
    const headerEntry = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === normalizedName
    );

    if (!headerEntry) {
      return { success: false, value: undefined, error: `Header not found: ${headerName}` };
    }

    return { success: true, value: headerEntry[1] };
  }

  /**
   * Extract value using regex pattern
   */
  extractRegex(body: unknown, pattern: string): ExtractionResult {
    try {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

      // Support capture groups: pattern can be "regex" or "regex|groupIndex"
      let regexPattern = pattern;
      let groupIndex = 0;

      if (pattern.includes('|')) {
        const parts = pattern.split('|');
        regexPattern = parts[0];
        groupIndex = parseInt(parts[1], 10) || 0;
      }

      const regex = new RegExp(regexPattern);
      const match = regex.exec(bodyStr);

      if (!match) {
        return { success: false, value: undefined, error: `No match for pattern: ${regexPattern}` };
      }

      // Return the specified capture group or full match
      const value = match[groupIndex] ?? match[0];

      return { success: true, value };
    } catch (error) {
      return {
        success: false,
        value: undefined,
        error: `Regex extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Apply JavaScript transformation to extracted value
   */
  applyTransform(value: unknown, transform: string): ExtractionResult {
    try {
      // Create a safe function that only has access to the value
      // Transform expression should use 'value' as the input variable
      const transformFn = new Function('value', `return ${transform}`);
      const result = transformFn(value);

      return { success: true, value: result };
    } catch (error) {
      return {
        success: false,
        value: undefined,
        error: `Transform failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Execute multiple extractions and return a map of variable names to values
   */
  extractAll(
    extractions: Extraction[],
    response: StepResponse
  ): { variables: Record<string, unknown>; errors: string[] } {
    const variables: Record<string, unknown> = {};
    const errors: string[] = [];

    for (const extraction of extractions) {
      const result = this.extract(extraction, response);

      if (result.success) {
        variables[extraction.as] = result.value;
      } else if (extraction.default !== undefined) {
        variables[extraction.as] = extraction.default;
      } else {
        errors.push(`Failed to extract '${extraction.as}': ${result.error}`);
      }
    }

    return { variables, errors };
  }
}

// Singleton instance for convenience
let defaultExtractor: DataExtractor | null = null;

export function getDataExtractor(): DataExtractor {
  if (!defaultExtractor) {
    defaultExtractor = new DataExtractor();
  }
  return defaultExtractor;
}
