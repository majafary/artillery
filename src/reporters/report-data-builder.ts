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
    if (!existsSync(artilleryOutputPath)) {
      throw new Error(`Artillery output file not found: ${artilleryOutputPath}. The test may have failed to complete.`);
    }

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
      stepMetrics: this.buildStepMetrics(enhancedData, aggregate),
      phases: this.buildPhases(artilleryData),
      errors: this.buildErrors(aggregate, enhancedData),
      thresholdResults: this.buildThresholdResults(aggregate),
      profiles: this.buildProfileMetrics(enhancedData, aggregate),
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
   * Supports both Artillery v2 (counters/rates) and v1 (flat) formats
   */
  private buildSummary(aggregate: ArtilleryAggregate): TestSummary {
    // v2 format: counters object
    const counters = aggregate.counters || {};
    const rates = aggregate.rates || {};

    // Get total requests (v2: counters['http.requests'], v1: requestsCompleted)
    const totalRequests = counters['http.requests'] || aggregate.requestsCompleted || 0;

    // Extract HTTP status codes from counters (v2 format: http.codes.XXX keys)
    const statusCodes: Record<number, number> = {};
    for (const [key, value] of Object.entries(counters)) {
      if (key.startsWith('http.codes.')) {
        const code = parseInt(key.replace('http.codes.', ''), 10);
        if (!isNaN(code)) {
          statusCodes[code] = value;
        }
      }
    }

    // Also check legacy codes format
    if (aggregate.codes) {
      for (const [code, count] of Object.entries(aggregate.codes)) {
        const codeNum = parseInt(code, 10);
        if (!isNaN(codeNum) && !statusCodes[codeNum]) {
          statusCodes[codeNum] = count;
        }
      }
    }

    // Calculate success (2xx) vs failure (4xx + 5xx) from status codes
    let successCount = 0;
    let clientErrors = 0;
    let serverErrors = 0;
    for (const [code, count] of Object.entries(statusCodes)) {
      const codeNum = parseInt(code, 10);
      if (codeNum >= 200 && codeNum < 300) {
        successCount += count;
      } else if (codeNum >= 400 && codeNum < 500) {
        clientErrors += count;
      } else if (codeNum >= 500) {
        serverErrors += count;
      }
    }

    // Count connection errors from counters (v2 format: errors.* keys)
    let connectionErrors = 0;
    for (const [key, value] of Object.entries(counters)) {
      if (key.startsWith('errors.')) {
        connectionErrors += value;
      }
    }

    // Also check legacy format
    if (aggregate.errors) {
      for (const value of Object.values(aggregate.errors)) {
        connectionErrors += value;
      }
    }

    // Total failed = HTTP 4xx + HTTP 5xx + connection errors
    const failedRequests = clientErrors + serverErrors + connectionErrors;

    // Get VU counts
    const vusersCreated = counters['vusers.created'] || aggregate.scenariosCreated || 0;
    const vusersFailed = counters['vusers.failed'] || 0;
    const vusersCompleted = (counters['vusers.completed'] || aggregate.scenariosCompleted || 0) ||
      (vusersCreated - vusersFailed);

    // Get throughput (v2: rates['http.request_rate'], v1: rps.mean)
    const throughput = rates['http.request_rate'] || aggregate.rps?.mean || 0;

    return {
      totalRequests,
      successfulRequests: successCount,
      failedRequests,
      errorRate: totalRequests > 0 ? failedRequests / totalRequests : 0,
      throughput,
      virtualUsers: {
        total: vusersCreated,
        completed: vusersCompleted,
        failed: vusersFailed,
      },
      statusCodes,
    };
  }

  /**
   * Build latency section
   * Supports both Artillery v2 (histograms) and v1 (flat latency) formats
   */
  private buildLatency(aggregate: ArtilleryAggregate): LatencyMetrics {
    // v2 format: histograms['http.response_time']
    const histograms = aggregate.histograms || {};
    const responseTimeHist = histograms['http.response_time'] || {};

    // v1 format: aggregate.latency
    const latency = aggregate.latency || {};

    // Merge v2 and v1, preferring v2
    return {
      min: responseTimeHist.min || latency.min || 0,
      max: responseTimeHist.max || latency.max || 0,
      mean: Math.round(responseTimeHist.mean || latency.mean || 0),
      median: responseTimeHist.median || responseTimeHist.p50 || latency.median || latency.p50 || 0,
      p90: responseTimeHist.p90 || latency.p90 || 0,
      p95: responseTimeHist.p95 || latency.p95 || 0,
      p99: responseTimeHist.p99 || latency.p99 || 0,
      stdDev: 0, // Artillery doesn't provide this directly
    };
  }

  /**
   * Build step metrics from Artillery output or enhanced report
   * Extracts step-level metrics from Artillery's counters/histograms
   */
  private buildStepMetrics(
    enhancedData: EnhancedReportData | null,
    aggregate?: ArtilleryAggregate
  ): Map<string, StepMetrics> {
    const metrics = new Map<string, StepMetrics>();

    // Initialize metrics for all journey steps
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

    // Extract step metrics from Artillery's counters/histograms
    if (aggregate) {
      const counters = aggregate.counters || {};
      const histograms = aggregate.histograms || {};

      // Parse step.{stepId}.status.{code} counters
      for (const [key, count] of Object.entries(counters)) {
        const statusMatch = key.match(/^step\.([^.]+)\.status\.(\d+)$/);
        if (statusMatch) {
          const [, stepId, statusCode] = statusMatch;
          const stepMetrics = metrics.get(stepId);
          if (stepMetrics) {
            const code = parseInt(statusCode, 10);
            stepMetrics.statusCodes.set(code, count);
            stepMetrics.requestCount += count;
            if (code >= 200 && code < 300) {
              stepMetrics.successCount += count;
            } else {
              stepMetrics.errorCount += count;
            }
          }
        }
      }

      // Parse step.{stepId}.response_time histograms
      for (const [key, hist] of Object.entries(histograms)) {
        const histMatch = key.match(/^step\.([^.]+)\.response_time$/);
        if (histMatch && hist) {
          const [, stepId] = histMatch;
          const stepMetrics = metrics.get(stepId);
          if (stepMetrics) {
            stepMetrics.latency = {
              min: hist.min || 0,
              max: hist.max || 0,
              mean: Math.round(hist.mean || 0),
              median: hist.median || hist.p50 || 0,
              p90: hist.p90 || 0,
              p95: hist.p95 || 0,
              p99: hist.p99 || 0,
              stdDev: 0,
            };
          }
        }
      }
    }

    // Override with enhanced data if available (more accurate)
    if (enhancedData?.stepMetrics) {
      for (const [stepId, data] of Object.entries(enhancedData.stepMetrics)) {
        metrics.set(stepId, {
          stepId,
          stepName: data.stepId,
          requestCount: data.requestCount,
          successCount: data.successCount,
          errorCount: data.errorCount,
          latency: data.latency,
          statusCodes: new Map(Object.entries(data.statusCodes).map(([k, v]) => [parseInt(k), v])),
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
   * Supports both Artillery v2 (counters/histograms) and v1 (flat) formats
   */
  private buildThresholdResults(aggregate: ArtilleryAggregate): ThresholdResult[] {
    const results: ThresholdResult[] = [];
    const thresholds = this.options.thresholds;

    if (!thresholds) return results;

    // Get latency from v2 histograms or v1 latency object
    const histograms = aggregate.histograms || {};
    const responseTimeHist = histograms['http.response_time'] || {};
    const latency = aggregate.latency || {};
    const lat = {
      p50: responseTimeHist.p50 || responseTimeHist.median || latency.p50 || latency.median || 0,
      p95: responseTimeHist.p95 || latency.p95 || 0,
      p99: responseTimeHist.p99 || latency.p99 || 0,
    };

    if (thresholds.p50ResponseTime !== undefined) {
      results.push({
        metric: 'p50 Response Time',
        threshold: thresholds.p50ResponseTime,
        actual: lat.p50,
        passed: lat.p50 <= thresholds.p50ResponseTime,
        unit: 'ms',
      });
    }

    if (thresholds.p95ResponseTime !== undefined) {
      results.push({
        metric: 'p95 Response Time',
        threshold: thresholds.p95ResponseTime,
        actual: lat.p95,
        passed: lat.p95 <= thresholds.p95ResponseTime,
        unit: 'ms',
      });
    }

    if (thresholds.p99ResponseTime !== undefined) {
      results.push({
        metric: 'p99 Response Time',
        threshold: thresholds.p99ResponseTime,
        actual: lat.p99,
        passed: lat.p99 <= thresholds.p99ResponseTime,
        unit: 'ms',
      });
    }

    if (thresholds.maxErrorRate !== undefined) {
      // v2: counters['http.requests'] and counters['errors.*']
      const counters = aggregate.counters || {};
      const totalRequests = counters['http.requests'] || aggregate.requestsCompleted || 0;

      // Count all error counters
      let errorCount = 0;
      for (const [key, value] of Object.entries(counters)) {
        if (key.startsWith('errors.')) {
          errorCount += value;
        }
      }

      const errorRate = totalRequests > 0 ? errorCount / totalRequests : 0;

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
   * Build profile metrics from Artillery output or enhanced report
   * Extracts profile data from Artillery's journey.profile.{name} counters
   */
  private buildProfileMetrics(
    enhancedData: EnhancedReportData | null,
    aggregate?: ArtilleryAggregate
  ): ProfileMetrics[] {
    const profiles: Record<string, number> = {};

    // Extract profile counts from Artillery's counters
    if (aggregate?.counters) {
      for (const [key, count] of Object.entries(aggregate.counters)) {
        const profileMatch = key.match(/^journey\.profile\.(.+)$/);
        if (profileMatch) {
          const [, profileName] = profileMatch;
          profiles[profileName] = count;
        }
      }
    }

    // Override with enhanced data if available
    if (enhancedData?.profiles) {
      Object.assign(profiles, enhancedData.profiles);
    }

    if (Object.keys(profiles).length === 0) return [];

    const total = Object.values(profiles).reduce((a, b) => a + b, 0);

    // Get journey duration from histograms if available
    let avgJourneyTime = 0;
    if (aggregate?.histograms?.['journey.duration']) {
      avgJourneyTime = aggregate.histograms['journey.duration'].mean || 0;
    } else if (enhancedData?.journeyDurations?.mean) {
      avgJourneyTime = enhancedData.journeyDurations.mean;
    }

    return Object.entries(profiles).map(([name, count]) => ({
      profileName: name,
      weight: 0, // Would need profile config to know target weight
      actualPercentage: total > 0 ? count / total : 0,
      userCount: count,
      completedJourneys: count, // Simplified
      failedJourneys: 0,
      avgJourneyTime,
    }));
  }
}

// Types for Artillery output (v2 format)
interface ArtilleryOutput {
  aggregate?: ArtilleryAggregate;
  intermediate?: ArtilleryAggregate[];
}

interface ArtilleryAggregate {
  // New v2 format uses nested objects
  counters?: Record<string, number>;
  rates?: Record<string, number>;
  histograms?: Record<string, {
    min?: number;
    max?: number;
    mean?: number;
    median?: number;
    p50?: number;
    p90?: number;
    p95?: number;
    p99?: number;
  }>;
  summaries?: Record<string, unknown>;

  // Legacy v1 format (for backwards compatibility)
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
