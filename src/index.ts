#!/usr/bin/env node
/**
 * Shield Artillery CLI
 * JSON-driven API performance testing framework
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { loadJourney } from './core/journey-loader.js';
import { loadProfileDistributor } from './core/profile-distributor.js';
import { ConfigMerger, findProjectConfig } from './core/config-merger.js';
import { ScriptGenerator } from './artillery/script-generator.js';
import { Runner } from './artillery/runner.js';
import { buildReportData } from './reporters/report-data-builder.js';
import { saveMarkdownReport } from './reporters/markdown-reporter.js';
import { saveHtmlReport } from './reporters/html-reporter.js';
import type { EnvironmentConfig, CliOptions, Journey } from './types/index.js';
import {
  parseDuration,
  formatDuration,
  formatNumber,
  renderProgressBar,
  formatProgressStats,
  type ProgressStats,
} from './utils/format.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load package.json for version
async function getVersion(): Promise<string> {
  try {
    const pkgPath = join(__dirname, '../package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
    return pkg.version;
  } catch {
    return '1.0.0';
  }
}

async function main() {
  const version = await getVersion();

  const program = new Command()
    .name('shield-artillery')
    .description('JSON-driven API performance testing framework')
    .version(version);

  // Run command
  program
    .command('run <journey>')
    .description('Run a load test from a journey configuration')
    .option('-e, --environment <name>', 'Environment name or path to env config')
    .option('-p, --profiles <path>', 'Path to user profiles configuration')
    .option('-o, --output <dir>', 'Output directory for reports', './reports')
    .option('-f, --format <formats...>', 'Report formats (markdown, html, json)', ['markdown', 'html'])
    .option('--dry-run', 'Generate Artillery script without running')
    .option('-v, --verbose', 'Verbose output')
    .option('-q, --quiet', 'Minimal output')
    .option('--debug', 'Log HTTP request/response details to debug file')
    .action(async (journeyPath: string, options) => {
      await runCommand(journeyPath, options);
    });

  // Validate command
  program
    .command('validate <journey>')
    .description('Validate a journey configuration')
    .action(async (journeyPath: string) => {
      await validateCommand(journeyPath);
    });

  // Generate command
  program
    .command('generate <journey>')
    .description('Generate Artillery script from journey')
    .option('-e, --environment <name>', 'Environment name or path')
    .option('-p, --profiles <path>', 'Path to user profiles')
    .option('-o, --output <path>', 'Output path for generated script')
    .action(async (journeyPath: string, options) => {
      await generateCommand(journeyPath, options);
    });

  // List command
  program
    .command('list')
    .description('List available journeys')
    .option('-d, --dir <path>', 'Directory to search', './journeys')
    .action(async (options) => {
      await listCommand(options);
    });

  await program.parseAsync(process.argv);
}

/**
 * Run command implementation
 */
async function runCommand(journeyPath: string, options: Record<string, unknown>) {
  console.log(chalk.blue('🚀 Shield Artillery - Load Test Runner\n'));

  try {
    // Load environment config
    const envConfig = await loadEnvironmentConfig(options.environment as string | undefined);

    // Load journey
    console.log(chalk.gray(`Loading journey: ${journeyPath}`));
    const { journey, flowEngine } = await loadJourney(journeyPath, {
      environment: envConfig,
    });
    console.log(chalk.green(`✓ Loaded journey: ${journey.name}`));

    // Validate journey
    const issues = flowEngine.validate();
    const errors = issues.filter((i) => i.type === 'error');
    if (errors.length > 0) {
      console.log(chalk.red('\n❌ Journey validation failed:'));
      for (const error of errors) {
        console.log(chalk.red(`  - ${error.message}`));
      }
      process.exit(1);
    }

    // Show journey paths
    const paths = flowEngine.enumeratePaths();
    console.log(chalk.gray(`  Possible paths: ${paths.length}`));

    // Load profiles if specified
    let profileConfig;
    const profileJourneys = new Map<string, Journey>();
    if (options.profiles) {
      console.log(chalk.gray(`Loading profiles: ${options.profiles}`));
      const distributor = await loadProfileDistributor(
        options.profiles as string,
        dirname(journeyPath)
      );
      profileConfig = (distributor as any).config;
      console.log(chalk.green(`✓ Loaded ${profileConfig.profiles.length} profiles`));

      // Load profile-specific journeys
      const profileBasePath = dirname(options.profiles as string);
      for (const profile of profileConfig.profiles) {
        if (profile.journey) {
          const profileJourneyPath = join(profileBasePath, profile.journey);
          console.log(chalk.gray(`  Loading journey for ${profile.name}: ${profile.journey}`));
          const { journey: profileJourney } = await loadJourney(profileJourneyPath, {
            environment: envConfig,
          });
          profileJourneys.set(profile.name, profileJourney);
        }
      }
      if (profileJourneys.size > 0) {
        console.log(chalk.green(`✓ Loaded ${profileJourneys.size} profile-specific journeys`));
      }
    }

    // Build config
    const merger = new ConfigMerger();
    const config = await merger.loadConfig({
      journeyPath,
      environmentPath: typeof options.environment === 'string' && options.environment.endsWith('.json')
        ? options.environment
        : undefined,
      cliOptions: {
        journey: journeyPath,
        profiles: options.profiles as string | undefined,
        output: options.output as string | undefined,
        format: options.format as string[] | undefined,
        dryRun: options.dryRun as boolean | undefined,
        verbose: options.verbose as boolean | undefined,
        quiet: options.quiet as boolean | undefined,
      },
    });

    // Generate script
    console.log(chalk.gray('\nGenerating Artillery script...'));
    const generator = new ScriptGenerator(journey, envConfig, profileConfig, profileJourneys);
    const validation = generator.validate();

    if (!validation.valid) {
      console.log(chalk.red('\n❌ Script generation failed:'));
      for (const error of validation.errors) {
        console.log(chalk.red(`  - ${error}`));
      }
      process.exit(1);
    }

    if (options.dryRun) {
      const script = generator.generate();
      console.log(chalk.green('\n✓ Script generated (dry run):\n'));
      console.log(chalk.gray(script.yaml));
      return;
    }

    // Calculate total test duration from environment config
    const phases = envConfig.load?.phases || [{ duration: '1m', arrivalRate: 1 }];
    const totalDurationMs = phases.reduce((total, phase) => {
      return total + parseDuration(phase.duration);
    }, 0);

    // Display pre-execution summary
    if (!options.quiet) {
      console.log(chalk.blue('\n📋 Test Plan:\n'));
      console.log(`   Journey:    ${chalk.white(journey.name)}`);
      console.log(`   Target:     ${chalk.cyan(envConfig.target.baseUrl)}`);
      console.log(`   Duration:   ${chalk.yellow(formatDuration(totalDurationMs))} (${phases.length} phase${phases.length > 1 ? 's' : ''})`);

      console.log('');
      phases.forEach((phase, i) => {
        const phaseName = phase.name || `Phase ${i + 1}`;
        const duration = typeof phase.duration === 'string' ? phase.duration : `${phase.duration}ms`;
        const rate = phase.rampTo
          ? `${phase.arrivalRate}→${phase.rampTo} req/s`
          : `${phase.arrivalRate} req/s`;
        console.log(chalk.gray(`   ${phaseName.padEnd(12)} - ${duration.padEnd(6)} @ ${rate}`));
      });
      console.log('');
    }

    // Run test
    console.log(chalk.blue('📊 Running Load Test...\n'));
    const runner = new Runner(config, {
      outputDir: options.output as string,
      verbose: options.verbose as boolean,
      quiet: options.quiet as boolean,
      debug: options.debug as boolean,
    });

    if (options.debug) {
      console.log(chalk.yellow('   Debug mode enabled - HTTP details will be logged to debug-*.log\n'));
    }

    // Progress tracking state
    const stats: ProgressStats = { requests: 0, errors: 0, errorTypes: {}, statusCodes: {}, vusers: 0, rps: 0, profiles: {} };
    const startTime = Date.now();
    let currentPhase = '';
    let progressInterval: ReturnType<typeof setInterval> | null = null;
    let lastLineCount = 0;

    // Clear previous progress lines
    const clearProgress = () => {
      if (lastLineCount > 0) {
        process.stdout.write(`\x1b[${lastLineCount}A`); // Move cursor up
        process.stdout.write('\x1b[0J'); // Clear from cursor to end
      }
    };

    // Render progress display
    const renderProgress = () => {
      if (options.quiet || options.verbose) return;

      clearProgress();

      const elapsed = Date.now() - startTime;
      const progressBar = renderProgressBar(elapsed, totalDurationMs);
      const elapsedStr = formatDuration(elapsed);
      const totalStr = formatDuration(totalDurationMs);
      const progressStats = formatProgressStats(stats);

      const lines = [
        `${progressBar} | ${elapsedStr} / ${totalStr}`,
        '',
        chalk.gray(`   ${progressStats.main}`),
        progressStats.statusLine ? chalk.cyan(`   HTTP: ${progressStats.statusLine}`) : '',
        progressStats.profileLine ? chalk.magenta(`   Profiles: ${progressStats.profileLine}`) : '',
        progressStats.errorBreakdown ? chalk.red(`   ⚠️  ${progressStats.errorBreakdown}`) : '',
        currentPhase ? chalk.blue(`   Phase: ${currentPhase}`) : '',
        '',
      ].filter(Boolean);

      console.log(lines.join('\n'));
      lastLineCount = lines.length;
    };

    // Handle progress events
    runner.on('progress', (data: Record<string, unknown>) => {
      if (options.quiet) return;

      switch (data.type) {
        case 'phase-start':
          currentPhase = `${data.name} (${data.duration})`;
          break;
        case 'phase-end':
          currentPhase = '';
          break;
        case 'requests':
          stats.requests += data.count as number;  // Accumulate interval values
          break;
        case 'rps':
          stats.rps = data.count as number;  // RPS is a rate, not cumulative
          break;
        case 'vusers':
          stats.vusers += data.count as number;  // Accumulate interval values
          break;
        case 'errors': {
          // Track error types - accumulate interval values
          const errorType = data.errorType as string;
          if (errorType) {
            stats.errorTypes[errorType] = (stats.errorTypes[errorType] || 0) + (data.count as number);
            // Recalculate total from all error types
            stats.errors = Object.values(stats.errorTypes).reduce((a, b) => a + b, 0);
          } else {
            stats.errors += data.count as number;
          }
          break;
        }
        case 'status-code': {
          // Track HTTP status codes - accumulate interval values
          const code = data.code as number;
          stats.statusCodes[code] = (stats.statusCodes[code] || 0) + (data.count as number);
          break;
        }
        case 'profile': {
          // Track profile distribution - accumulate interval values
          const profileName = data.name as string;
          stats.profiles[profileName] = (stats.profiles[profileName] || 0) + (data.count as number);
          break;
        }
        case 'complete':
          if (progressInterval) {
            clearInterval(progressInterval);
            progressInterval = null;
          }
          clearProgress();
          console.log(chalk.green(`   ${data.message}\n`));
          break;
      }
    });

    // Start progress update interval (every second)
    if (!options.quiet && !options.verbose) {
      progressInterval = setInterval(renderProgress, 1000);
      renderProgress(); // Initial render
    }

    const result = await runner.run();

    // Clean up progress interval
    if (progressInterval) {
      clearInterval(progressInterval);
      clearProgress();
    }

    if (!result.success) {
      console.log(chalk.red('\n❌ Test failed:'));
      for (const error of result.errors) {
        console.log(chalk.red(`  - ${error}`));
      }
      process.exit(1);
    }

    // Generate reports
    console.log(chalk.gray('\nGenerating reports...'));

    const reportData = await buildReportData(result.outputPath, {
      journey,
      environment: envConfig.name,
      thresholds: envConfig.thresholds,
    });

    const formats = options.format as string[];
    const outputDir = options.output as string;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (formats.includes('markdown')) {
      const mdPath = join(outputDir, `report-${timestamp}.md`);
      await saveMarkdownReport(reportData, mdPath);
      console.log(chalk.green(`✓ Markdown report: ${mdPath}`));
    }

    if (formats.includes('html')) {
      const htmlPath = join(outputDir, `report-${timestamp}.html`);
      await saveHtmlReport(reportData, htmlPath);
      console.log(chalk.green(`✓ HTML report: ${htmlPath}`));
    }

    // Print summary
    console.log(chalk.blue('\n📈 Test Summary:\n'));
    console.log(`  Total Requests:    ${chalk.white(reportData.summary.totalRequests)}`);
    console.log(`  Success Rate:      ${chalk.green(((1 - reportData.summary.errorRate) * 100).toFixed(2) + '%')}`);
    console.log(`  p95 Response Time: ${chalk.yellow(reportData.latency.p95 + 'ms')}`);
    console.log(`  Throughput:        ${chalk.cyan(reportData.summary.throughput.toFixed(2) + ' req/s')}`);
    console.log(`  Duration:          ${chalk.gray((result.duration / 1000).toFixed(0) + 's')}`);

    // Check thresholds
    const failedThresholds = reportData.thresholdResults.filter((t) => !t.passed);
    if (failedThresholds.length > 0) {
      console.log(chalk.red('\n⚠️  Threshold violations:'));
      for (const t of failedThresholds) {
        console.log(chalk.red(`  - ${t.metric}: ${t.actual}${t.unit} (threshold: ${t.threshold}${t.unit})`));
      }
      process.exit(1);
    }

    console.log(chalk.green('\n✅ Test completed successfully!\n'));
  } catch (error) {
    console.log(chalk.red(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}\n`));
    process.exit(1);
  }
}

/**
 * Validate command implementation
 */
async function validateCommand(journeyPath: string) {
  console.log(chalk.blue('🔍 Validating journey configuration...\n'));

  try {
    const { journey, flowEngine } = await loadJourney(journeyPath, { skipValidation: false });

    console.log(chalk.green(`✓ Schema validation passed`));
    console.log(chalk.gray(`  Journey: ${journey.name} (${journey.id})`));
    console.log(chalk.gray(`  Steps: ${journey.steps.length}`));

    const issues = flowEngine.validate();
    const errors = issues.filter((i) => i.type === 'error');
    const warnings = issues.filter((i) => i.type === 'warning');

    if (errors.length > 0) {
      console.log(chalk.red('\n❌ Structure errors:'));
      for (const error of errors) {
        console.log(chalk.red(`  - ${error.message}`));
      }
    }

    if (warnings.length > 0) {
      console.log(chalk.yellow('\n⚠️  Warnings:'));
      for (const warning of warnings) {
        console.log(chalk.yellow(`  - ${warning.message}`));
      }
    }

    const paths = flowEngine.enumeratePaths();
    console.log(chalk.gray(`\n  Possible execution paths: ${paths.length}`));
    for (const path of paths.slice(0, 5)) {
      console.log(chalk.gray(`    ${path.steps.join(' → ')}`));
    }
    if (paths.length > 5) {
      console.log(chalk.gray(`    ... and ${paths.length - 5} more`));
    }

    if (errors.length === 0) {
      console.log(chalk.green('\n✅ Journey is valid!\n'));
    } else {
      process.exit(1);
    }
  } catch (error) {
    console.log(chalk.red(`\n❌ Validation failed: ${error instanceof Error ? error.message : String(error)}\n`));
    process.exit(1);
  }
}

/**
 * Generate command implementation
 */
async function generateCommand(journeyPath: string, options: Record<string, unknown>) {
  console.log(chalk.blue('⚙️  Generating Artillery script...\n'));

  try {
    const envConfig = await loadEnvironmentConfig(options.environment as string | undefined);
    const { journey } = await loadJourney(journeyPath, { environment: envConfig });

    let profileConfig;
    const profileJourneys = new Map<string, Journey>();
    if (options.profiles) {
      const distributor = await loadProfileDistributor(
        options.profiles as string,
        dirname(journeyPath)
      );
      profileConfig = (distributor as any).config;

      // Load profile-specific journeys
      const profileBasePath = dirname(options.profiles as string);
      for (const profile of profileConfig.profiles) {
        if (profile.journey) {
          const profileJourneyPath = join(profileBasePath, profile.journey);
          const { journey: profileJourney } = await loadJourney(profileJourneyPath, {
            environment: envConfig,
          });
          profileJourneys.set(profile.name, profileJourney);
        }
      }
    }

    const generator = new ScriptGenerator(journey, envConfig, profileConfig, profileJourneys);
    const script = generator.generate();

    if (options.output) {
      const { writeFile, mkdir } = await import('fs/promises');
      await mkdir(dirname(options.output as string), { recursive: true });
      await writeFile(options.output as string, script.yaml);
      console.log(chalk.green(`✓ Script saved to: ${options.output}`));

      // Get absolute path to the processor module
      // Use .cjs extension so Node treats it as CommonJS (project uses "type": "module")
      const processorModulePath = join(__dirname, 'artillery', 'processor.js');
      const processorPath = join(dirname(options.output as string), 'processor.cjs');
      await writeFile(processorPath, generator.generateProcessor(processorModulePath));
      console.log(chalk.green(`✓ Processor saved to: ${processorPath}`));
    } else {
      console.log(script.yaml);
    }
  } catch (error) {
    console.log(chalk.red(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}\n`));
    process.exit(1);
  }
}

/**
 * List command implementation
 */
async function listCommand(options: Record<string, unknown>) {
  const dir = options.dir as string;

  if (!existsSync(dir)) {
    console.log(chalk.yellow(`Directory not found: ${dir}`));
    return;
  }

  const { readdir } = await import('fs/promises');
  const files = await readdir(dir);
  const journeys = files.filter((f) => f.endsWith('.journey.json'));

  if (journeys.length === 0) {
    console.log(chalk.yellow('No journey files found'));
    return;
  }

  console.log(chalk.blue('📋 Available Journeys:\n'));

  for (const file of journeys) {
    try {
      const { journey } = await loadJourney(join(dir, file), { skipValidation: true });
      console.log(`  ${chalk.green(journey.id)}`);
      console.log(chalk.gray(`    Name: ${journey.name}`));
      console.log(chalk.gray(`    Steps: ${journey.steps.length}`));
      console.log(chalk.gray(`    File: ${file}\n`));
    } catch (error) {
      console.log(`  ${chalk.red(file)}`);
      console.log(chalk.red(`    Error loading: ${error instanceof Error ? error.message : String(error)}\n`));
    }
  }
}

/**
 * Load environment configuration
 */
async function loadEnvironmentConfig(envOption?: string): Promise<EnvironmentConfig> {
  if (!envOption) {
    return {
      name: 'default',
      target: { baseUrl: 'http://localhost:3000' },
    };
  }

  // Check if it's a file path
  if (envOption.endsWith('.json') && existsSync(envOption)) {
    const content = await readFile(envOption, 'utf-8');
    return JSON.parse(content);
  }

  // Look for environment file
  const possiblePaths = [
    `./environments/${envOption}.env.json`,
    `./${envOption}.env.json`,
    `./config/${envOption}.json`,
  ];

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      const content = await readFile(path, 'utf-8');
      return JSON.parse(content);
    }
  }

  // Return default with environment name
  return {
    name: envOption,
    target: { baseUrl: 'http://localhost:3000' },
  };
}

// Run CLI
main().catch((error) => {
  console.error(chalk.red(`Fatal error: ${error.message}`));
  process.exit(1);
});
