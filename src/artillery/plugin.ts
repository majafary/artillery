/**
 * Shield Artillery Plugin
 * Custom Artillery plugin for enhanced metrics and reporting
 */

import type { EventEmitter } from 'events';
import type { StepMetrics, LatencyMetrics, ReportData } from '../types/index.js';

interface PluginConfig {
  enabled?: boolean;
  stepMetrics?: boolean;
  reportPath?: string;
}

interface ArtilleryScript {
  config: {
    target: string;
    plugins?: Record<string, PluginConfig>;
    variables?: Record<string, unknown>;
    phases?: Array<{
      duration: string;
      arrivalRate?: number;
    }>;
  };
}

interface StepMetricData {
  stepId: string;
  responseTimes: number[];
  statusCodes: Map<number, number>;
  errorCount: number;
  successCount: number;
  branchCounts: Map<string, number>;
}

/**
 * Artillery Plugin Class
 * Artillery automatically instantiates this with (script, events)
 */
class ShieldArtilleryPlugin {
  private script: ArtilleryScript;
  private events: EventEmitter;
  private config: PluginConfig;
  private stepMetrics: Map<string, StepMetricData> = new Map();
  private journeyDurations: number[] = [];
  private profileCounts: Map<string, number> = new Map();
  private pathCounts: Map<string, number> = new Map();
  private startTime: number = Date.now();
  private finalStats: unknown = null;

  constructor(script: ArtilleryScript, events: EventEmitter) {
    this.script = script;
    this.events = events;
    // Plugin is loaded via local path './plugin.cjs'
    this.config = script.config.plugins?.['./plugin.cjs'] || { enabled: true };

    if (!this.config.enabled) {
      return;
    }

    this.setupListeners();
  }

  /**
   * Set up event listeners
   */
  private setupListeners(): void {
    // Listen for custom histogram events (step response times)
    this.events.on('histogram', (name: string, value: number) => {
      this.handleHistogram(name, value);
    });

    // Listen for custom counter events
    this.events.on('counter', (name: string, value: number) => {
      this.handleCounter(name, value);
    });

    // Listen for stats events (periodic summaries)
    this.events.on('stats', (stats: unknown) => {
      this.handleStats(stats);
    });

    // Listen for done event (test complete)
    this.events.on('done', (stats: unknown) => {
      this.handleDone(stats);
    });

    // Listen for phase events
    this.events.on('phaseStarted', (phase: unknown) => {
      this.handlePhaseStarted(phase);
    });

    this.events.on('phaseCompleted', (phase: unknown) => {
      this.handlePhaseCompleted(phase);
    });
  }

  /**
   * Handle histogram events (timing data)
   */
  private handleHistogram(name: string, value: number): void {
    // Step response time: step.{stepId}.response_time
    if (name.startsWith('step.') && name.endsWith('.response_time')) {
      const stepId = name.replace('step.', '').replace('.response_time', '');
      this.recordStepResponseTime(stepId, value);
    }

    // Journey duration
    if (name === 'journey.duration') {
      this.journeyDurations.push(value);
    }
  }

  /**
   * Handle counter events
   */
  private handleCounter(name: string, value: number): void {
    // Step status codes: step.{stepId}.status.{code}
    if (name.startsWith('step.') && name.includes('.status.')) {
      const parts = name.split('.');
      const stepId = parts[1];
      const statusCode = parseInt(parts[3], 10);
      this.recordStepStatusCode(stepId, statusCode, value);
    }

    // Step branches: step.{stepId}.branch.{nextStepId}
    if (name.startsWith('step.') && name.includes('.branch.')) {
      const parts = name.split('.');
      const stepId = parts[1];
      const nextStepId = parts[3];
      this.recordStepBranch(stepId, nextStepId, value);
    }

    // Profile counts: journey.profile.{profileName}
    if (name.startsWith('journey.profile.')) {
      const profileName = name.replace('journey.profile.', '');
      const current = this.profileCounts.get(profileName) || 0;
      this.profileCounts.set(profileName, current + value);
    }

    // Path counts: journey.path.{path}
    if (name.startsWith('journey.path.')) {
      const path = name.replace('journey.path.', '');
      const current = this.pathCounts.get(path) || 0;
      this.pathCounts.set(path, current + value);
    }

    // Extraction errors: extraction.errors.{stepId}
    if (name.startsWith('extraction.errors.')) {
      const stepId = name.replace('extraction.errors.', '');
      const metrics = this.getOrCreateStepMetrics(stepId);
      metrics.errorCount += value;
    }
  }

  /**
   * Record step response time
   */
  private recordStepResponseTime(stepId: string, responseTime: number): void {
    const metrics = this.getOrCreateStepMetrics(stepId);
    metrics.responseTimes.push(responseTime);
  }

  /**
   * Record step status code
   */
  private recordStepStatusCode(stepId: string, statusCode: number, count: number): void {
    const metrics = this.getOrCreateStepMetrics(stepId);
    const current = metrics.statusCodes.get(statusCode) || 0;
    metrics.statusCodes.set(statusCode, current + count);

    // Track success/error
    if (statusCode >= 200 && statusCode < 300) {
      metrics.successCount += count;
    } else {
      metrics.errorCount += count;
    }
  }

  /**
   * Record step branch taken
   */
  private recordStepBranch(stepId: string, nextStepId: string, count: number): void {
    const metrics = this.getOrCreateStepMetrics(stepId);
    const current = metrics.branchCounts.get(nextStepId) || 0;
    metrics.branchCounts.set(nextStepId, current + count);
  }

  /**
   * Get or create step metrics
   */
  private getOrCreateStepMetrics(stepId: string): StepMetricData {
    let metrics = this.stepMetrics.get(stepId);
    if (!metrics) {
      metrics = {
        stepId,
        responseTimes: [],
        statusCodes: new Map(),
        errorCount: 0,
        successCount: 0,
        branchCounts: new Map(),
      };
      this.stepMetrics.set(stepId, metrics);
    }
    return metrics;
  }

  /**
   * Handle periodic stats events
   */
  private handleStats(stats: unknown): void {
    // Could emit intermediate progress here
  }

  /**
   * Handle phase started
   */
  private handlePhaseStarted(phase: unknown): void {
    // Track phase progress
  }

  /**
   * Handle phase completed
   */
  private handlePhaseCompleted(phase: unknown): void {
    // Track phase completion
  }

  /**
   * Handle test done
   */
  private handleDone(stats: unknown): void {
    this.finalStats = stats;
  }

  /**
   * Cleanup function - called before Artillery exits
   */
  cleanup(done: () => void): void {
    // Generate enhanced report data if configured
    if (this.config.reportPath) {
      this.generateEnhancedReport()
        .then(() => done())
        .catch(() => done());
    } else {
      done();
    }
  }

  /**
   * Generate enhanced report with step-level metrics
   */
  private async generateEnhancedReport(): Promise<void> {
    const reportData = this.buildReportData();

    if (this.config.reportPath) {
      const { writeFile, mkdir } = await import('fs/promises');
      const { dirname } = await import('path');

      await mkdir(dirname(this.config.reportPath), { recursive: true });
      await writeFile(
        this.config.reportPath,
        JSON.stringify(reportData, mapReplacer, 2)
      );
    }
  }

  /**
   * Build report data structure
   */
  private buildReportData(): EnhancedReportData {
    const stepMetrics: Record<string, FormattedStepMetrics> = {};

    for (const [stepId, data] of this.stepMetrics) {
      stepMetrics[stepId] = {
        stepId: data.stepId,
        requestCount: data.successCount + data.errorCount,
        successCount: data.successCount,
        errorCount: data.errorCount,
        latency: this.calculateLatencyMetrics(data.responseTimes),
        statusCodes: Object.fromEntries(data.statusCodes),
        branches: Object.fromEntries(data.branchCounts),
      };
    }

    return {
      metadata: {
        startTime: new Date(this.startTime).toISOString(),
        endTime: new Date().toISOString(),
        duration: Date.now() - this.startTime,
      },
      stepMetrics,
      profiles: Object.fromEntries(this.profileCounts),
      paths: Object.fromEntries(this.pathCounts),
      journeyDurations: {
        count: this.journeyDurations.length,
        ...this.calculateLatencyMetrics(this.journeyDurations),
      },
    };
  }

  /**
   * Calculate latency percentiles
   */
  private calculateLatencyMetrics(values: number[]): LatencyMetrics {
    if (values.length === 0) {
      return { min: 0, max: 0, mean: 0, median: 0, p90: 0, p95: 0, p99: 0, stdDev: 0 };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const mean = sum / sorted.length;

    // Standard deviation
    const squaredDiffs = sorted.map((v) => Math.pow(v - mean, 2));
    const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / sorted.length;
    const stdDev = Math.sqrt(avgSquaredDiff);

    return {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: Math.round(mean),
      median: this.percentile(sorted, 50),
      p90: this.percentile(sorted, 90),
      p95: this.percentile(sorted, 95),
      p99: this.percentile(sorted, 99),
      stdDev: Math.round(stdDev),
    };
  }

  /**
   * Calculate percentile
   */
  private percentile(sorted: number[], p: number): number {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
  }
}

interface EnhancedReportData {
  metadata: {
    startTime: string;
    endTime: string;
    duration: number;
  };
  stepMetrics: Record<string, FormattedStepMetrics>;
  profiles: Record<string, number>;
  paths: Record<string, number>;
  journeyDurations: LatencyMetrics & { count: number };
}

interface FormattedStepMetrics {
  stepId: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  latency: LatencyMetrics;
  statusCodes: Record<number, number>;
  branches: Record<string, number>;
}

/**
 * JSON replacer for Map objects
 */
function mapReplacer(key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(value);
  }
  return value;
}

// Export for Artillery plugin system (ESM export, wrapper converts to CommonJS)
export { ShieldArtilleryPlugin as Plugin };
