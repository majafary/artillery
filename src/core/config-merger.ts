/**
 * Configuration Merger
 * Handles layered configuration: base → project → environment → CLI
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { merge } from 'lodash-es';
import type {
  EnvironmentConfig,
  FrameworkConfig,
  ReportingConfig,
  ExecutionConfig,
  CliOptions,
} from '../types/index.js';

/**
 * Default framework configuration
 */
const DEFAULT_CONFIG: Partial<FrameworkConfig> = {
  reporting: {
    outputDir: './reports',
    formats: ['markdown', 'html'],
    includeStepMetrics: true,
    includeRawData: false,
  },
  execution: {
    dryRun: false,
    verbose: false,
    quiet: false,
    failOnThreshold: true,
  },
};

/**
 * Configuration merger class
 */
export class ConfigMerger {
  private baseConfig: Partial<FrameworkConfig>;

  constructor(baseConfig?: Partial<FrameworkConfig>) {
    this.baseConfig = merge({}, DEFAULT_CONFIG, baseConfig || {});
  }

  /**
   * Load and merge all configuration layers
   */
  async loadConfig(options: ConfigLoadOptions): Promise<FrameworkConfig> {
    const layers: Partial<FrameworkConfig>[] = [this.baseConfig];

    // Load project config if exists
    if (options.projectConfigPath && existsSync(options.projectConfigPath)) {
      const projectConfig = await this.loadJsonFile<Partial<FrameworkConfig>>(options.projectConfigPath);
      layers.push(projectConfig);
    }

    // Load environment config
    const envConfig = await this.loadEnvironmentConfig(options);
    layers.push({ environment: envConfig });

    // Apply CLI overrides
    if (options.cliOptions) {
      layers.push(this.cliToConfig(options.cliOptions));
    }

    // Merge all layers
    const merged = this.mergeLayers(layers);

    // Validate required fields
    this.validateConfig(merged);

    return merged as FrameworkConfig;
  }

  /**
   * Load environment configuration from file
   */
  private async loadEnvironmentConfig(options: ConfigLoadOptions): Promise<EnvironmentConfig> {
    let envConfig: EnvironmentConfig;

    if (options.environmentPath) {
      envConfig = await this.loadJsonFile(options.environmentPath);
    } else if (options.environmentName && options.environmentsDir) {
      // Look for {env}.env.json in environments directory
      const envPath = join(options.environmentsDir, `${options.environmentName}.env.json`);
      if (existsSync(envPath)) {
        envConfig = await this.loadJsonFile(envPath);
      } else {
        throw new Error(`Environment file not found: ${envPath}`);
      }
    } else {
      // Use minimal default environment
      envConfig = {
        name: 'default',
        target: {
          baseUrl: 'http://localhost:3000',
        },
      };
    }

    return envConfig;
  }

  /**
   * Convert CLI options to config format
   */
  private cliToConfig(cli: CliOptions): Partial<FrameworkConfig> {
    const config: Partial<FrameworkConfig> = {};

    // Journey config
    config.journey = {
      path: cli.journey,
    };

    // Profile config
    if (cli.profiles) {
      config.profiles = {
        path: cli.profiles,
      };
    }

    // Reporting config
    if (cli.output || cli.format) {
      config.reporting = {} as ReportingConfig;
      if (cli.output) {
        config.reporting.outputDir = cli.output;
      }
      if (cli.format) {
        config.reporting.formats = cli.format as ReportingConfig['formats'];
      }
    }

    // Execution config
    config.execution = {} as ExecutionConfig;
    if (cli.dryRun !== undefined) {
      config.execution.dryRun = cli.dryRun;
    }
    if (cli.verbose !== undefined) {
      config.execution.verbose = cli.verbose;
    }
    if (cli.quiet !== undefined) {
      config.execution.quiet = cli.quiet;
    }

    return config;
  }

  /**
   * Merge multiple configuration layers
   */
  private mergeLayers(layers: Partial<FrameworkConfig>[]): Partial<FrameworkConfig> {
    return layers.reduce((acc, layer) => merge(acc, layer), {});
  }

  /**
   * Load and parse a JSON file
   */
  private async loadJsonFile<T>(path: string): Promise<T> {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content) as T;
  }

  /**
   * Validate that required config fields are present
   */
  private validateConfig(config: Partial<FrameworkConfig>): void {
    const errors: string[] = [];

    if (!config.journey?.path) {
      errors.push('Journey path is required');
    }

    if (!config.environment?.target?.baseUrl) {
      errors.push('Environment target baseUrl is required');
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n  ${errors.join('\n  ')}`);
    }
  }
}

export interface ConfigLoadOptions {
  // Journey file path (required)
  journeyPath: string;

  // Environment config path (direct path to env file)
  environmentPath?: string;

  // OR environment name + directory
  environmentName?: string;
  environmentsDir?: string;

  // Project config path
  projectConfigPath?: string;

  // CLI overrides
  cliOptions?: CliOptions;
}

/**
 * Convenience function to load config with defaults
 */
export async function loadConfig(options: ConfigLoadOptions): Promise<FrameworkConfig> {
  const merger = new ConfigMerger();
  return merger.loadConfig(options);
}

/**
 * Find project config file by walking up directory tree
 */
export async function findProjectConfig(startPath: string): Promise<string | null> {
  const configNames = ['shield-artillery.config.json', '.shield-artillery.json'];
  let currentDir = dirname(startPath);

  while (currentDir !== dirname(currentDir)) {
    for (const name of configNames) {
      const configPath = join(currentDir, name);
      if (existsSync(configPath)) {
        return configPath;
      }
    }
    currentDir = dirname(currentDir);
  }

  return null;
}
