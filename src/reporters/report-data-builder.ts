/**
 * Report Data Builder
 * Converts Artillery output to ReportData structure
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import type {
  ReportData,
  ReportMetadata,
  TestSummary,
  LatencyMetrics,
  StepMetrics,
  PhaseResult,
  ErrorSummary,
  ThresholdResult,
  ProfileMetrics,
  ThresholdsConfig,
  Journey,
} from '../types/index.js';

export interface BuilderOptions {
  journey: Journey;
  environment: string;
  thresholds?: ThresholdsConfig;
  enhancedReportPath?: string;
}

export class ReportDataBuilder {
  private options: BuilderOptions;

  constructor(options: BuilderOptions) {
    this.options = options;
  }

  /**
   * Build ReportData from Artillery JSON output
   */
  async build(artilleryOutputPath: string): Promise<ReportData> {
    const artilleryData = await this.loadArtilleryOutput(artilleryOutputPath);

    // Load enhanced report if available
    let enhancedData: EnhancedReportData | null = null;
    if (this.options.enhancedReportPath && existsSync(this.options.enhancedReportPath)) {
      enhancedData = await this.loadEnhancedReport(this.options.enhancedReportPath);
    }

    const aggregate = artilleryData.aggregate || {};

    return {
      metadata: this.buildMetadata(artilleryData),
      summary: this.buildSummary(aggregate),
      latency: this.buildLatency(aggregate),
      stepMetrics: this.buildStepMetrics(enhancedData),
      phases: this.buildPhases(artilleryData),
      errors: this.buildErrors(aggregate, enhancedData),
      thresholdResults: this.buildThresholdResults(aggregate),
      profiles: this.buildProfileMetrics(enhancedData),
    };
  }

  /**
   * Load Artillery JSON output
   */
  private async loadArtilleryOutput(path: string): Promise<ArtilleryOutput> {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * Load enhanced report from plugin
   */
  private async loadEnhancedReport(path: string): Promise<EnhancedReportData> {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * Build metadata section
   */
  private buildMetadata(data: ArtilleryOutput): ReportMetadata {
    return {
      testName: `${this.options.journey.name} Load Test`,
      journeyId: this.options.journey.id,
      journeyName: this.options.journey.name,
      environment: this.options.environment,
      startTime: new Date(data.aggregate?.firstCounterAt || Date.now()),
      endTime: new Date(data.aggregate?.lastCounterAt || Date.now()),
      duration: data.aggregate?.lastCounterAt && data.aggregate?.firstCounterAt
        ? data.aggregate.lastCounterAt - data.aggregate.firstCounterAt
        : 0,
      version: '1.0.0',
    };
  }

  /**
   * Build summary section
   */
  private buildSummary(aggregate: ArtilleryAggregate): TestSummary {
    const totalRequests = aggregate.requestsCompleted || 0;
    const failedRequests =
      (aggregate.codes?.['4xx'] || 0) +
      (aggregate.codes?.['5xx'] || 0) +
      (aggregate.errors?.length || 0);

    return {
      totalRequests,
      successfulRequests: totalRequests - failedRequests,
      failedRequests,
      errorRate: totalRequests > 0 ? failedRequests / totalRequests : 0,
      throughput: aggregate.rps?.mean || 0,
      virtualUsers: {
        total: aggregate.scenariosCreated || 0,
        completed: aggregate.scenariosCompleted || 0,
        failed: (aggregate.scenariosCreated || 0) - (aggregate.scenariosCompleted || 0),
      },
    };
  }

  /**
   * Build latency section
   */
  private buildLatency(aggregate: ArtilleryAggregate): LatencyMetrics {
    const latency = aggregate.latency || {};
    return {
      min: latency.min || 0,
      max: latency.max || 0,
      mean: Math.round(latency.mean || 0),
      median: latency.median || latency.p50 || 0,
      p90: latency.p90 || 0,
      p95: latency.p95 || 0,
      p99: latency.p99 || 0,
      stdDev: 0, // Artillery doesn't provide this directly
    };
  }

  /**
   * Build step metrics from enhanced report
   */
  private buildStepMetrics(enhancedData: EnhancedReportData | null): Map<string, StepMetrics> {
    const metrics = new Map<string, StepMetrics>();

    // Use enhanced data if available
    if (enhancedData?.stepMetrics) {
      for (const [stepId, data] of Object.entries(enhancedData.stepMetrics)) {
        metrics.set(stepId, {
          stepId,
          stepName: data.stepId, // Use step ID as name if not available
          requestCount: data.requestCount,
          successCount: data.successCount,
          errorCount: data.errorCount,
          latency: data.latency,
          statusCodes: new Map(Object.entries(data.statusCodes).map(([k, v]) => [parseInt(k), v])),
          errorMessages: new Map(),
        });
      }
    } else {
      // Create basic step metrics from journey definition
      for (const step of this.options.journey.steps) {
        metrics.set(step.id, {
          stepId: step.id,
          stepName: step.name || step.id,
          requestCount: 0,
          successCount: 0,
          errorCount: 0,
          latency: { min: 0, max: 0, mean: 0, median: 0, p90: 0, p95: 0, p99: 0, stdDev: 0 },
          statusCodes: new Map(),
          errorMessages: new Map(),
        });
      }
    }

    return metrics;
  }

  /**
   * Build phase results
   */
  private buildPhases(data: ArtilleryOutput): PhaseResult[] {
    if (!data.intermediate) return [];

    // Group by phase
    const phases: PhaseResult[] = [];
    let phaseIndex = 0;

    for (const interval of data.intermediate) {
      // Each intermediate entry could be considered a phase checkpoint
      phases.push({
        name: `Phase ${++phaseIndex}`,
        duration: 10000, // Default 10s intervals
        arrivalRate: interval.scenariosCreated || 0,
        actualRate: (interval.scenariosCreated || 0) / 10,
        completedUsers: interval.scenariosCompleted || 0,
        failedUsers: (interval.scenariosCreated || 0) - (interval.scenariosCompleted || 0),
      });
    }

    return phases;
  }

  /**
   * Build error summary
   */
  private buildErrors(
    aggregate: ArtilleryAggregate,
    enhancedData: EnhancedReportData | null
  ): ErrorSummary[] {
    const errors: ErrorSummary[] = [];

    // From Artillery aggregate errors
    if (aggregate.errors) {
      for (const [message, count] of Object.entries(aggregate.errors)) {
        errors.push({
          stepId: 'unknown',
          errorType: this.classifyError(message),
          message,
          count: count as number,
          firstOccurrence: new Date(),
          lastOccurrence: new Date(),
        });
      }
    }

    return errors;
  }

  /**
   * Classify error type from message
   */
  private classifyError(message: string): ErrorSummary['errorType'] {
    const lower = message.toLowerCase();
    if (lower.includes('timeout')) return 'timeout';
    if (lower.includes('connect') || lower.includes('econnrefused')) return 'connection';
    if (lower.includes('status') || lower.includes('4') || lower.includes('5')) return 'status_code';
    if (lower.includes('extract')) return 'extraction';
    if (lower.includes('valid')) return 'validation';
    return 'unknown';
  }

  /**
   * Build threshold results
   */
  private buildThresholdResults(aggregate: ArtilleryAggregate): ThresholdResult[] {
    const results: ThresholdResult[] = [];
    const thresholds = this.options.thresholds;

    if (!thresholds) return results;

    const latency = aggregate.latency || {};

    if (thresholds.p50ResponseTime !== undefined) {
      results.push({
        metric: 'p50 Response Time',
        threshold: thresholds.p50ResponseTime,
        actual: latency.p50 || latency.median || 0,
        passed: (latency.p50 || latency.median || 0) <= thresholds.p50ResponseTime,
        unit: 'ms',
      });
    }

    if (thresholds.p95ResponseTime !== undefined) {
      results.push({
        metric: 'p95 Response Time',
        threshold: thresholds.p95ResponseTime,
        actual: latency.p95 || 0,
        passed: (latency.p95 || 0) <= thresholds.p95ResponseTime,
        unit: 'ms',
      });
    }

    if (thresholds.p99ResponseTime !== undefined) {
      results.push({
        metric: 'p99 Response Time',
        threshold: thresholds.p99ResponseTime,
        actual: latency.p99 || 0,
        passed: (latency.p99 || 0) <= thresholds.p99ResponseTime,
        unit: 'ms',
      });
    }

    if (thresholds.maxErrorRate !== undefined) {
      const totalRequests = aggregate.requestsCompleted || 0;
      const failedRequests =
        (aggregate.codes?.['4xx'] || 0) + (aggregate.codes?.['5xx'] || 0);
      const errorRate = totalRequests > 0 ? failedRequests / totalRequests : 0;

      results.push({
        metric: 'Error Rate',
        threshold: thresholds.maxErrorRate * 100,
        actual: Math.round(errorRate * 10000) / 100,
        passed: errorRate <= thresholds.maxErrorRate,
        unit: '%',
      });
    }

    return results;
  }

  /**
   * Build profile metrics
   */
  private buildProfileMetrics(enhancedData: EnhancedReportData | null): ProfileMetrics[] {
    if (!enhancedData?.profiles) return [];

    const total = Object.values(enhancedData.profiles).reduce((a, b) => a + b, 0);

    return Object.entries(enhancedData.profiles).map(([name, count]) => ({
      profileName: name,
      weight: 0, // Would need profile config to know target weight
      actualPercentage: total > 0 ? count / total : 0,
      userCount: count,
      completedJourneys: count, // Simplified
      failedJourneys: 0,
      avgJourneyTime: enhancedData.journeyDurations?.mean || 0,
    }));
  }
}

// Types for Artillery output
interface ArtilleryOutput {
  aggregate?: ArtilleryAggregate;
  intermediate?: ArtilleryAggregate[];
}

interface ArtilleryAggregate {
  scenariosCreated?: number;
  scenariosCompleted?: number;
  requestsCompleted?: number;
  latency?: {
    min?: number;
    max?: number;
    mean?: number;
    median?: number;
    p50?: number;
    p90?: number;
    p95?: number;
    p99?: number;
  };
  rps?: {
    mean?: number;
    max?: number;
  };
  codes?: Record<string, number>;
  errors?: Record<string, number>;
  firstCounterAt?: number;
  lastCounterAt?: number;
}

interface EnhancedReportData {
  stepMetrics?: Record<string, {
    stepId: string;
    requestCount: number;
    successCount: number;
    errorCount: number;
    latency: LatencyMetrics;
    statusCodes: Record<string, number>;
  }>;
  profiles?: Record<string, number>;
  journeyDurations?: {
    mean?: number;
  };
}

/**
 * Convenience function to build report data
 */
export async function buildReportData(
  artilleryOutputPath: string,
  options: BuilderOptions
): Promise<ReportData> {
  const builder = new ReportDataBuilder(options);
  return builder.build(artilleryOutputPath);
}
