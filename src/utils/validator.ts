/**
 * JSON Schema Validator
 * Validates journey, profile, and environment configurations against schemas
 */

import Ajv, { type ValidateFunction, type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { Journey, ProfileConfig, EnvironmentConfig } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMAS_DIR = join(__dirname, '../../schemas');

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  path: string;
  message: string;
  keyword: string;
  params: Record<string, unknown>;
}

export class Validator {
  private ajv: Ajv;
  private validators: Map<SchemaType, ValidateFunction> = new Map();
  private initialized = false;

  constructor() {
    this.ajv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: true,
    });
    addFormats(this.ajv);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const schemaTypes: SchemaType[] = ['journey', 'profile', 'environment'];

    for (const type of schemaTypes) {
      const schemaPath = join(SCHEMAS_DIR, `${type}.schema.json`);
      const schemaContent = await readFile(schemaPath, 'utf-8');
      const schema = JSON.parse(schemaContent);
      const validate = this.ajv.compile(schema);
      this.validators.set(type, validate);
    }

    this.initialized = true;
  }

  validateJourney(data: unknown): ValidationResult {
    return this.validate('journey', data);
  }

  validateProfile(data: unknown): ValidationResult {
    return this.validate('profile', data);
  }

  validateEnvironment(data: unknown): ValidationResult {
    return this.validate('environment', data);
  }

  private validate(type: SchemaType, data: unknown): ValidationResult {
    const validator = this.validators.get(type);
    if (!validator) {
      throw new Error(`Validator not initialized. Call initialize() first.`);
    }

    const valid = validator(data);

    if (valid) {
      return { valid: true, errors: [] };
    }

    const errors = this.formatErrors(validator.errors || []);
    return { valid: false, errors };
  }

  private formatErrors(errors: ErrorObject[]): ValidationError[] {
    return errors.map((error) => ({
      path: error.instancePath || '/',
      message: this.formatErrorMessage(error),
      keyword: error.keyword,
      params: error.params as Record<string, unknown>,
    }));
  }

  private formatErrorMessage(error: ErrorObject): string {
    const { keyword, params, message } = error;

    switch (keyword) {
      case 'required':
        return `Missing required property: ${(params as { missingProperty: string }).missingProperty}`;
      case 'type':
        return `Expected ${(params as { type: string }).type}, got ${typeof error.data}`;
      case 'enum':
        return `Value must be one of: ${(params as { allowedValues: unknown[] }).allowedValues.join(', ')}`;
      case 'pattern':
        return `String does not match pattern: ${(params as { pattern: string }).pattern}`;
      case 'minimum':
        return `Value must be >= ${(params as { limit: number }).limit}`;
      case 'maximum':
        return `Value must be <= ${(params as { limit: number }).limit}`;
      case 'minItems':
        return `Array must have at least ${(params as { limit: number }).limit} item(s)`;
      case 'additionalProperties':
        return `Unknown property: ${(params as { additionalProperty: string }).additionalProperty}`;
      default:
        return message || `Validation failed: ${keyword}`;
    }
  }
}

type SchemaType = 'journey' | 'profile' | 'environment';

/**
 * Convenience functions for quick validation
 */
let defaultValidator: Validator | null = null;

async function getValidator(): Promise<Validator> {
  if (!defaultValidator) {
    defaultValidator = new Validator();
    await defaultValidator.initialize();
  }
  return defaultValidator;
}

export async function validateJourney(data: unknown): Promise<ValidationResult> {
  const validator = await getValidator();
  return validator.validateJourney(data);
}

export async function validateProfile(data: unknown): Promise<ValidationResult> {
  const validator = await getValidator();
  return validator.validateProfile(data);
}

export async function validateEnvironment(data: unknown): Promise<ValidationResult> {
  const validator = await getValidator();
  return validator.validateEnvironment(data);
}

/**
 * Async validation check functions
 */
export async function isValidJourney(data: unknown): Promise<boolean> {
  const result = await validateJourney(data);
  return result.valid;
}

export async function isValidProfile(data: unknown): Promise<boolean> {
  const result = await validateProfile(data);
  return result.valid;
}

export async function isValidEnvironment(data: unknown): Promise<boolean> {
  const result = await validateEnvironment(data);
  return result.valid;
}

/**
 * Format validation errors for display
 */
export function formatValidationErrors(result: ValidationResult): string {
  if (result.valid) return 'Validation passed';

  const lines = ['Validation failed:'];
  for (const error of result.errors) {
    lines.push(`  - ${error.path}: ${error.message}`);
  }
  return lines.join('\n');
}
