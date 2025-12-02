/**
 * Artillery Runner
 * Executes Artillery tests and captures results
 */

import { spawn, type ChildProcess } from 'child_process';
import { writeFile, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import type {
  Journey,
  ProfileConfig,
  EnvironmentConfig,
  FrameworkConfig,
} from '../types/index.js';
import { ScriptGenerator, type GeneratedScript } from './script-generator.js';
import { loadJourney } from '../core/journey-loader.js';
import { loadProfileDistributor } from '../core/profile-distributor.js';

export interface RunnerOptions {
  /** Output directory for generated files */
  outputDir?: string;
  /** Keep generated files after run */
  keepGeneratedFiles?: boolean;
  /** Verbose output */
  verbose?: boolean;
  /** Quiet mode (minimal output) */
  quiet?: boolean;
  /** Dry run (generate but don't execute) */
  dryRun?: boolean;
}

export interface RunResult {
  success: boolean;
  duration: number;
  outputPath: string;
  metrics: RunMetrics;
  errors: string[];
}

export interface RunMetrics {
  scenariosCreated: number;
  scenariosCompleted: number;
  requestsCompleted: number;
  requestsFailed: number;
  latency: {
    min: number;
    max: number;
    median: number;
    p95: number;
    p99: number;
  };
  rps: {
    mean: number;
    max: number;
  };
  codes: Record<number, number>;
}

export class Runner extends EventEmitter {
  private config: FrameworkConfig;
  private options: RunnerOptions;
  private tempDir: string | null = null;
  private artilleryProcess: ChildProcess | null = null;

  constructor(config: FrameworkConfig, options: RunnerOptions = {}) {
    super();
    this.config = config;
    this.options = {
      outputDir: './artillery-output',
      keepGeneratedFiles: false,
      verbose: false,
      quiet: false,
      dryRun: false,
      ...options,
    };
  }

  /**
   * Run the load test
   */
  async run(): Promise<RunResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    try {
      // Load journey and profiles
      const loadedJourney = await loadJourney(this.config.journey.path, {
        environment: this.config.environment,
      });

      let profiles: ProfileConfig | undefined;
      if (this.config.profiles?.path) {
        const distributor = await loadProfileDistributor(
          this.config.profiles.path,
          dirname(this.config.journey.path)
        );
        profiles = (distributor as any).config;
      }

      // Generate Artillery script
      const generator = new ScriptGenerator(
        loadedJourney.journey,
        this.config.environment,
        profiles
      );

      const validation = generator.validate();
      if (!validation.valid) {
        return {
          success: false,
          duration: Date.now() - startTime,
          outputPath: '',
          metrics: this.emptyMetrics(),
          errors: validation.errors,
        };
      }

      const script = generator.generate();

      // Create temp directory for generated files
      this.tempDir = await this.createTempDir();

      // Write generated files
      const scriptPath = join(this.tempDir, 'test.yml');
      // Use .cjs extension so Node treats it as CommonJS (project uses "type": "module")
      const processorPath = join(this.tempDir, 'processor.cjs');

      // Get absolute path to the processor module (in same dir as runner)
      const processorModulePath = join(__dirname, 'processor.js');

      await writeFile(scriptPath, script.yaml);
      await writeFile(processorPath, generator.generateProcessor(processorModulePath));

      this.emit('generated', { scriptPath, processorPath });

      if (this.options.dryRun) {
        return {
          success: true,
          duration: Date.now() - startTime,
          outputPath: this.tempDir,
          metrics: this.emptyMetrics(),
          errors: [],
        };
      }

      // Run Artillery
      // Use absolute path so Artillery writes to correct location regardless of cwd
      const outputPath = resolve(
        this.options.outputDir!,
        `report-${Date.now()}.json`
      );
      await mkdir(dirname(outputPath), { recursive: true });

      const result = await this.executeArtillery(scriptPath, outputPath);

      // Parse results
      const metrics = await this.parseResults(outputPath);

      // Cleanup temp files
      if (!this.options.keepGeneratedFiles && this.tempDir) {
        await rm(this.tempDir, { recursive: true, force: true });
      }

      return {
        success: result.code === 0,
        duration: Date.now() - startTime,
        outputPath,
        metrics,
        errors: result.errors,
      };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return {
        success: false,
        duration: Date.now() - startTime,
        outputPath: '',
        metrics: this.emptyMetrics(),
        errors,
      };
    }
  }

  /**
   * Create temporary directory for generated files
   */
  private async createTempDir(): Promise<string> {
    const tempDir = resolve(
      this.options.outputDir!,
      `.temp-${Date.now()}`
    );
    await mkdir(tempDir, { recursive: true });
    return tempDir;
  }

  /**
   * Execute Artillery process
   */
  private executeArtillery(
    scriptPath: string,
    outputPath: string
  ): Promise<{ code: number; errors: string[] }> {
    return new Promise((resolve) => {
      const args = ['run', '--output', outputPath, scriptPath];

      if (this.options.quiet) {
        args.push('--quiet');
      }

      this.artilleryProcess = spawn('npx', ['artillery', ...args], {
        cwd: dirname(scriptPath),
        stdio: this.options.verbose ? 'inherit' : 'pipe',
      });

      const errors: string[] = [];
      let stderr = '';

      if (this.artilleryProcess.stderr) {
        this.artilleryProcess.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      }

      if (this.artilleryProcess.stdout && !this.options.verbose) {
        this.artilleryProcess.stdout.on('data', (data) => {
          const line = data.toString();
          this.emit('output', line);

          // Parse progress from Artillery output
          if (line.includes('Elapsed time:')) {
            this.emit('progress', { message: line.trim() });
          }
        });
      }

      this.artilleryProcess.on('close', (code) => {
        if (stderr) {
          errors.push(stderr);
        }
        resolve({ code: code ?? 1, errors });
        this.artilleryProcess = null;
      });

      this.artilleryProcess.on('error', (error) => {
        errors.push(error.message);
        resolve({ code: 1, errors });
        this.artilleryProcess = null;
      });
    });
  }

  /**
   * Parse Artillery JSON output
   */
  private async parseResults(outputPath: string): Promise<RunMetrics> {
    if (!existsSync(outputPath)) {
      return this.emptyMetrics();
    }

    try {
      const { readFile } = await import('fs/promises');
      const content = await readFile(outputPath, 'utf-8');
      const data = JSON.parse(content);

      const aggregate = data.aggregate;
      if (!aggregate) {
        return this.emptyMetrics();
      }

      return {
        scenariosCreated: aggregate.scenariosCreated || 0,
        scenariosCompleted: aggregate.scenariosCompleted || 0,
        requestsCompleted: aggregate.requestsCompleted || 0,
        requestsFailed: aggregate.requestsFailed || 0,
        latency: {
          min: aggregate.latency?.min || 0,
          max: aggregate.latency?.max || 0,
          median: aggregate.latency?.median || 0,
          p95: aggregate.latency?.p95 || 0,
          p99: aggregate.latency?.p99 || 0,
        },
        rps: {
          mean: aggregate.rps?.mean || 0,
          max: aggregate.rps?.max || 0,
        },
        codes: aggregate.codes || {},
      };
    } catch {
      return this.emptyMetrics();
    }
  }

  /**
   * Return empty metrics structure
   */
  private emptyMetrics(): RunMetrics {
    return {
      scenariosCreated: 0,
      scenariosCompleted: 0,
      requestsCompleted: 0,
      requestsFailed: 0,
      latency: { min: 0, max: 0, median: 0, p95: 0, p99: 0 },
      rps: { mean: 0, max: 0 },
      codes: {},
    };
  }

  /**
   * Stop a running test
   */
  stop(): void {
    if (this.artilleryProcess) {
      this.artilleryProcess.kill('SIGTERM');
    }
  }
}

/**
 * Convenience function to run a test
 */
export async function runTest(
  config: FrameworkConfig,
  options?: RunnerOptions
): Promise<RunResult> {
  const runner = new Runner(config, options);
  return runner.run();
}
