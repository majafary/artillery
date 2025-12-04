/**
 * Configuration Types
 * Environment and framework configuration
 */

export interface EnvironmentConfig {
  name: string;
  variables?: Record<string, string>;
  target: TargetConfig;
  load?: LoadConfig;
  thresholds?: ThresholdsConfig;
  http?: HttpConfig;
}

export interface TargetConfig {
  baseUrl: string;
  timeout?: number;
}

export interface LoadConfig {
  phases: LoadPhase[];
}

export interface LoadPhase {
  name?: string;
  duration: string;
  arrivalRate?: number;
  arrivalCount?: number;
  rampTo?: number;
  maxVusers?: number;
  pause?: string;
}

export interface ThresholdsConfig {
  p50ResponseTime?: number;
  p95ResponseTime?: number;
  p99ResponseTime?: number;
  maxResponseTime?: number;
  maxErrorRate?: number;
  minThroughput?: number;
}

export interface HttpConfig {
  pool?: number;
  timeout?: number;
  maxRedirects?: number;
}

/**
 * Framework configuration (merged from all layers)
 */
export interface FrameworkConfig {
  environment: EnvironmentConfig;
  journey: {
    path: string;
    baseUrl?: string;
  };
  profiles?: {
    path: string;
  };
  reporting: ReportingConfig;
  execution: ExecutionConfig;
}

export interface ReportingConfig {
  outputDir: string;
  formats: ReportFormat[];
  includeStepMetrics: boolean;
  includeRawData: boolean;
}

export type ReportFormat = 'markdown' | 'html' | 'json' | 'csv';

export interface ExecutionConfig {
  dryRun: boolean;
  verbose: boolean;
  quiet: boolean;
  failOnThreshold: boolean;
}

/**
 * CLI Options (runtime overrides)
 */
export interface CliOptions {
  journey: string;
  environment?: string;
  profiles?: string;
  output?: string;
  format?: string[];
  vusers?: number;
  duration?: string;
  dryRun?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}
