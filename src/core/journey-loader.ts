/**
 * Journey Loader
 * Loads, validates, and prepares journey configurations for execution
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join, isAbsolute } from 'path';
import type { Journey, Step, EnvironmentConfig } from '../types/index.js';
import { Validator, formatValidationErrors } from '../utils/validator.js';
import { interpolateObject, buildContext } from '../utils/template.js';
import { FlowEngine, type ValidationIssue } from './flow-engine.js';

export interface LoadedJourney {
  journey: Journey;
  flowEngine: FlowEngine;
  basePath: string;
}

export interface JourneyLoadOptions {
  /** Environment config for variable resolution */
  environment?: EnvironmentConfig;
  /** Additional variables to make available */
  variables?: Record<string, unknown>;
  /** Skip validation (for testing) */
  skipValidation?: boolean;
}

export class JourneyLoader {
  private validator: Validator;
  private initialized = false;

  constructor() {
    this.validator = new Validator();
  }

  /**
   * Initialize the loader (loads JSON schemas)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.validator.initialize();
    this.initialized = true;
  }

  /**
   * Load a journey from file path
   */
  async load(journeyPath: string, options: JourneyLoadOptions = {}): Promise<LoadedJourney> {
    await this.initialize();

    // Resolve path
    const absolutePath = isAbsolute(journeyPath)
      ? journeyPath
      : join(process.cwd(), journeyPath);

    if (!existsSync(absolutePath)) {
      throw new Error(`Journey file not found: ${absolutePath}`);
    }

    // Load and parse JSON
    const content = await readFile(absolutePath, 'utf-8');
    let journey: Journey;

    try {
      journey = JSON.parse(content);
    } catch (error) {
      throw new Error(
        `Failed to parse journey JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Validate against schema
    if (!options.skipValidation) {
      const validationResult = this.validator.validateJourney(journey);
      if (!validationResult.valid) {
        throw new Error(formatValidationErrors(validationResult));
      }
    }

    // Build variable context for interpolation
    const context = this.buildVariableContext(journey, options);

    // Interpolate variables in journey
    journey = this.resolveVariables(journey, context);

    // Create flow engine and validate structure
    const flowEngine = new FlowEngine(journey);
    const structureIssues = flowEngine.validate();

    const errors = structureIssues.filter((i) => i.type === 'error');
    if (errors.length > 0) {
      throw new Error(
        `Journey structure errors:\n${errors.map((e) => `  - ${e.message}`).join('\n')}`
      );
    }

    return {
      journey,
      flowEngine,
      basePath: dirname(absolutePath),
    };
  }

  /**
   * Build variable context from all sources
   */
  private buildVariableContext(
    journey: Journey,
    options: JourneyLoadOptions
  ): Record<string, unknown> {
    const context: Record<string, unknown> = {};

    // Environment variables (accessible via {{env.VAR}})
    if (options.environment) {
      context.env = {
        ...options.environment.variables,
        API_BASE_URL: options.environment.target.baseUrl,
      };
    }

    // Journey-level variables
    if (journey.variables) {
      Object.assign(context, journey.variables);
    }

    // Additional variables from options
    if (options.variables) {
      Object.assign(context, options.variables);
    }

    return context;
  }

  /**
   * Resolve all variable references in journey
   */
  private resolveVariables(journey: Journey, context: Record<string, unknown>): Journey {
    // Deep clone to avoid mutating original
    const resolved = JSON.parse(JSON.stringify(journey)) as Journey;

    // Interpolate baseUrl
    if (resolved.baseUrl) {
      resolved.baseUrl = interpolateObject(resolved.baseUrl, context);
    }

    // Interpolate defaults
    if (resolved.defaults) {
      resolved.defaults = interpolateObject(resolved.defaults, context);
    }

    // Note: We don't interpolate step-level variables here
    // Those are resolved at runtime with user data context

    return resolved;
  }

  /**
   * Load multiple journeys from a directory
   */
  async loadDirectory(
    dirPath: string,
    options: JourneyLoadOptions = {}
  ): Promise<LoadedJourney[]> {
    const { readdir } = await import('fs/promises');
    const absolutePath = isAbsolute(dirPath) ? dirPath : join(process.cwd(), dirPath);

    const files = await readdir(absolutePath);
    const journeyFiles = files.filter(
      (f) => f.endsWith('.journey.json') || f.endsWith('.journey.yaml')
    );

    const journeys: LoadedJourney[] = [];
    for (const file of journeyFiles) {
      const journey = await this.load(join(absolutePath, file), options);
      journeys.push(journey);
    }

    return journeys;
  }

  /**
   * Validate a journey without loading fully
   */
  async validate(journeyPath: string): Promise<ValidationResult> {
    await this.initialize();

    const absolutePath = isAbsolute(journeyPath)
      ? journeyPath
      : join(process.cwd(), journeyPath);

    if (!existsSync(absolutePath)) {
      return {
        valid: false,
        schemaErrors: [],
        structureIssues: [],
        error: `File not found: ${absolutePath}`,
      };
    }

    const content = await readFile(absolutePath, 'utf-8');
    let journey: Journey;

    try {
      journey = JSON.parse(content);
    } catch (error) {
      return {
        valid: false,
        schemaErrors: [],
        structureIssues: [],
        error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // Schema validation
    const schemaResult = this.validator.validateJourney(journey);

    // Structure validation
    let structureIssues: ValidationIssue[] = [];
    if (schemaResult.valid) {
      const flowEngine = new FlowEngine(journey);
      structureIssues = flowEngine.validate();
    }

    const hasErrors =
      !schemaResult.valid || structureIssues.some((i) => i.type === 'error');

    return {
      valid: !hasErrors,
      schemaErrors: schemaResult.errors,
      structureIssues,
    };
  }
}

export interface ValidationResult {
  valid: boolean;
  schemaErrors: Array<{ path: string; message: string }>;
  structureIssues: ValidationIssue[];
  error?: string;
}

// Singleton instance
let defaultLoader: JourneyLoader | null = null;

export async function getJourneyLoader(): Promise<JourneyLoader> {
  if (!defaultLoader) {
    defaultLoader = new JourneyLoader();
    await defaultLoader.initialize();
  }
  return defaultLoader;
}

export async function loadJourney(
  path: string,
  options?: JourneyLoadOptions
): Promise<LoadedJourney> {
  const loader = await getJourneyLoader();
  return loader.load(path, options);
}
