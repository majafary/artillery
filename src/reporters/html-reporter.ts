/**
 * HTML Reporter
 * Generates interactive HTML reports with charts
 */

import Handlebars from 'handlebars';
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { ReportData, StepMetrics, ChartData } from '../types/index.js';

/**
 * HTML template with embedded Chart.js
 */
const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{metadata.testName}} - Performance Report</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      line-height: 1.6;
      color: #333;
      background: #f5f5f5;
      padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
      border-radius: 10px;
      margin-bottom: 20px;
    }
    .header h1 { font-size: 2em; margin-bottom: 10px; }
    .header .meta { opacity: 0.9; font-size: 0.9em; }
    .card {
      background: white;
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    .card h2 {
      color: #667eea;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 2px solid #eee;
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
    .stat-box {
      background: #f8f9fa;
      padding: 20px;
      border-radius: 8px;
      text-align: center;
    }
    .stat-box .value { font-size: 2em; font-weight: bold; color: #667eea; }
    .stat-box .label { color: #666; font-size: 0.9em; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f8f9fa; font-weight: 600; color: #555; }
    tr:hover { background: #f8f9fa; }
    .success { color: #28a745; }
    .error { color: #dc3545; }
    .chart-container { position: relative; height: 300px; margin: 20px 0; }
    .status-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 0.85em;
      font-weight: 500;
    }
    .status-pass { background: #d4edda; color: #155724; }
    .status-fail { background: #f8d7da; color: #721c24; }
    .tabs { display: flex; border-bottom: 2px solid #eee; margin-bottom: 20px; }
    .tab {
      padding: 10px 20px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -2px;
    }
    .tab.active { border-bottom-color: #667eea; color: #667eea; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>{{metadata.testName}}</h1>
      <div class="meta">
        <strong>Journey:</strong> {{metadata.journeyName}} |
        <strong>Environment:</strong> {{metadata.environment}} |
        <strong>Date:</strong> {{formatDate metadata.startTime}} |
        <strong>Duration:</strong> {{formatDuration metadata.duration}}
      </div>
    </div>

    <div class="grid">
      <div class="stat-box">
        <div class="value">{{formatNumber summary.totalRequests}}</div>
        <div class="label">Total Requests</div>
      </div>
      <div class="stat-box">
        <div class="value {{#if (gt summary.errorRate 0.01)}}error{{else}}success{{/if}}">
          {{formatPercent summary.errorRate}}
        </div>
        <div class="label">Error Rate</div>
      </div>
      <div class="stat-box">
        <div class="value">{{latency.p95}}ms</div>
        <div class="label">p95 Latency</div>
      </div>
      <div class="stat-box">
        <div class="value">{{formatNumber summary.throughput}}</div>
        <div class="label">Requests/sec</div>
      </div>
    </div>

    <div class="card">
      <h2>Response Time Distribution</h2>
      <div class="chart-container">
        <canvas id="latencyChart"></canvas>
      </div>
    </div>

    <div class="card">
      <h2>Step Performance</h2>
      <div class="chart-container">
        <canvas id="stepChart"></canvas>
      </div>
      <table>
        <thead>
          <tr>
            <th>Step</th>
            <th>Requests</th>
            <th>Success Rate</th>
            <th>Mean</th>
            <th>p50</th>
            <th>p95</th>
            <th>p99</th>
          </tr>
        </thead>
        <tbody>
          {{#each stepMetricsArray}}
          <tr>
            <td>{{this.stepName}}</td>
            <td>{{this.requestCount}}</td>
            <td class="{{#if (gt (successRate this) 0.99)}}success{{else}}error{{/if}}">
              {{formatPercent (successRate this)}}
            </td>
            <td>{{this.latency.mean}}ms</td>
            <td>{{this.latency.median}}ms</td>
            <td>{{this.latency.p95}}ms</td>
            <td>{{this.latency.p99}}ms</td>
          </tr>
          {{/each}}
        </tbody>
      </table>
    </div>

    {{#if thresholdResults.length}}
    <div class="card">
      <h2>Threshold Validation</h2>
      <table>
        <thead>
          <tr>
            <th>Metric</th>
            <th>Threshold</th>
            <th>Actual</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {{#each thresholdResults}}
          <tr>
            <td>{{this.metric}}</td>
            <td>{{this.threshold}}{{this.unit}}</td>
            <td>{{this.actual}}{{this.unit}}</td>
            <td>
              <span class="status-badge {{#if this.passed}}status-pass{{else}}status-fail{{/if}}">
                {{#if this.passed}}Pass{{else}}Fail{{/if}}
              </span>
            </td>
          </tr>
          {{/each}}
        </tbody>
      </table>
    </div>
    {{/if}}

    {{#if errors.length}}
    <div class="card">
      <h2>Errors</h2>
      <table>
        <thead>
          <tr>
            <th>Step</th>
            <th>Type</th>
            <th>Message</th>
            <th>Count</th>
          </tr>
        </thead>
        <tbody>
          {{#each errors}}
          <tr>
            <td>{{this.stepId}}</td>
            <td>{{this.errorType}}</td>
            <td>{{this.message}}</td>
            <td class="error">{{this.count}}</td>
          </tr>
          {{/each}}
        </tbody>
      </table>
    </div>
    {{/if}}

    <div class="card">
      <h2>Virtual Users</h2>
      <div class="grid">
        <div class="stat-box">
          <div class="value">{{summary.virtualUsers.total}}</div>
          <div class="label">Total</div>
        </div>
        <div class="stat-box">
          <div class="value success">{{summary.virtualUsers.completed}}</div>
          <div class="label">Completed</div>
        </div>
        <div class="stat-box">
          <div class="value error">{{summary.virtualUsers.failed}}</div>
          <div class="label">Failed</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    // Latency Distribution Chart
    const latencyCtx = document.getElementById('latencyChart').getContext('2d');
    new Chart(latencyCtx, {
      type: 'bar',
      data: {
        labels: ['Min', 'Mean', 'Median', 'p90', 'p95', 'p99', 'Max'],
        datasets: [{
          label: 'Response Time (ms)',
          data: [{{latency.min}}, {{latency.mean}}, {{latency.median}}, {{latency.p90}}, {{latency.p95}}, {{latency.p99}}, {{latency.max}}],
          backgroundColor: 'rgba(102, 126, 234, 0.6)',
          borderColor: 'rgba(102, 126, 234, 1)',
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, title: { display: true, text: 'Time (ms)' } } }
      }
    });

    // Step Comparison Chart
    const stepCtx = document.getElementById('stepChart').getContext('2d');
    new Chart(stepCtx, {
      type: 'bar',
      data: {
        labels: [{{{stepLabelsJson}}}],
        datasets: [
          {
            label: 'p50',
            data: [{{{stepP50Json}}}],
            backgroundColor: 'rgba(102, 126, 234, 0.6)',
          },
          {
            label: 'p95',
            data: [{{{stepP95Json}}}],
            backgroundColor: 'rgba(118, 75, 162, 0.6)',
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { y: { beginAtZero: true, title: { display: true, text: 'Time (ms)' } } }
      }
    });
  </script>
</body>
</html>`;

export class HtmlReporter {
  private template: Handlebars.TemplateDelegate;

  constructor(customTemplate?: string) {
    this.registerHelpers();
    this.template = Handlebars.compile(customTemplate || HTML_TEMPLATE);
  }

  /**
   * Register Handlebars helpers
   */
  private registerHelpers(): void {
    Handlebars.registerHelper('formatDate', (date: Date | string) => {
      const d = new Date(date);
      return d.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    });

    Handlebars.registerHelper('formatDuration', (ms: number) => {
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
      return `${seconds}s`;
    });

    Handlebars.registerHelper('formatNumber', (num: number) => {
      return Math.round(num).toLocaleString();
    });

    Handlebars.registerHelper('formatPercent', (num: number) => {
      return `${(num * 100).toFixed(2)}%`;
    });

    Handlebars.registerHelper('successRate', (metrics: StepMetrics) => {
      if (metrics.requestCount === 0) return 0;
      return metrics.successCount / metrics.requestCount;
    });

    Handlebars.registerHelper('gt', (a: number, b: number) => a > b);
  }

  /**
   * Generate HTML report
   */
  generate(data: ReportData): string {
    const stepMetricsArray = Array.from(data.stepMetrics.values());

    // Prepare chart data as JSON strings
    const stepLabels = stepMetricsArray.map((s) => `'${s.stepName}'`).join(', ');
    const stepP50 = stepMetricsArray.map((s) => s.latency.median).join(', ');
    const stepP95 = stepMetricsArray.map((s) => s.latency.p95).join(', ');

    const templateData = {
      ...data,
      stepMetricsArray,
      stepLabelsJson: stepLabels,
      stepP50Json: stepP50,
      stepP95Json: stepP95,
    };

    return this.template(templateData);
  }

  /**
   * Generate and save report to file
   */
  async save(data: ReportData, outputPath: string): Promise<void> {
    const html = this.generate(data);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, html, 'utf-8');
  }
}

/**
 * Convenience function to generate HTML report
 */
export function generateHtmlReport(data: ReportData): string {
  const reporter = new HtmlReporter();
  return reporter.generate(data);
}

/**
 * Convenience function to save HTML report
 */
export async function saveHtmlReport(
  data: ReportData,
  outputPath: string
): Promise<void> {
  const reporter = new HtmlReporter();
  await reporter.save(data, outputPath);
}
