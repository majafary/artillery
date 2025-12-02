/**
 * Profile Distributor
 * Handles weighted user profile distribution and data generation
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, isAbsolute, dirname } from 'path';
import { parse } from 'csv-parse/sync';
import { faker } from '@faker-js/faker';
import { v4 as uuidv4 } from 'uuid';
import type {
  ProfileConfig,
  Profile,
  UserData,
  Generator,
  GeneratorType,
  UserContext,
  NormalizedProfile,
  ProfileDistributionStats,
} from '../types/index.js';
import { Validator, formatValidationErrors } from '../utils/validator.js';

export class ProfileDistributor {
  private config: ProfileConfig;
  private normalizedProfiles: NormalizedProfile[] = [];
  private userDataCache: Map<string, UserData[]> = new Map();
  private userIndexes: Map<string, number> = new Map();
  private sequenceCounters: Map<string, number> = new Map();
  private basePath: string;
  private stats: ProfileDistributionStats;

  constructor(config: ProfileConfig, basePath: string = process.cwd()) {
    this.config = config;
    this.basePath = basePath;
    this.stats = {
      totalUsers: 0,
      profileCounts: {},
      profilePercentages: {},
    };

    this.normalizeWeights();
  }

  /**
   * Normalize profile weights to cumulative percentages
   */
  private normalizeWeights(): void {
    const totalWeight = this.config.profiles.reduce((sum, p) => sum + p.weight, 0);

    if (totalWeight === 0) {
      throw new Error('Total profile weight cannot be zero');
    }

    let cumulative = 0;
    this.normalizedProfiles = this.config.profiles.map((profile) => {
      const normalizedWeight = profile.weight / totalWeight;
      cumulative += normalizedWeight;
      return {
        ...profile,
        normalizedWeight,
        cumulativeWeight: cumulative,
      };
    });

    // Initialize stats
    for (const profile of this.config.profiles) {
      this.stats.profileCounts[profile.name] = 0;
      this.stats.profilePercentages[profile.name] = 0;
      this.userIndexes.set(profile.name, 0);
    }
  }

  /**
   * Load user data from all profile data sources
   */
  async loadData(): Promise<void> {
    for (const profile of this.config.profiles) {
      if (profile.dataSource) {
        const data = await this.loadDataSource(profile.dataSource);
        this.userDataCache.set(profile.name, data);
      } else if (profile.data) {
        this.userDataCache.set(profile.name, profile.data);
      } else {
        // Empty data - generators only
        this.userDataCache.set(profile.name, [{}]);
      }
    }
  }

  /**
   * Load data from CSV file
   */
  private async loadDataSource(sourcePath: string): Promise<UserData[]> {
    const absolutePath = isAbsolute(sourcePath)
      ? sourcePath
      : join(this.basePath, sourcePath);

    if (!existsSync(absolutePath)) {
      throw new Error(`Data source not found: ${absolutePath}`);
    }

    const content = await readFile(absolutePath, 'utf-8');

    if (absolutePath.endsWith('.csv')) {
      return parse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    } else if (absolutePath.endsWith('.json')) {
      const data = JSON.parse(content);
      return Array.isArray(data) ? data : [data];
    }

    throw new Error(`Unsupported data source format: ${absolutePath}`);
  }

  /**
   * Get the next user based on weighted distribution
   */
  getNextUser(): UserContext {
    // Select profile based on weighted random
    const profile = this.selectProfile();

    // Get user data (round-robin within profile)
    const userData = this.getNextUserData(profile.name);

    // Generate dynamic values
    const generatedValues = this.generateValues(profile);

    // Merge static variables
    const variables = { ...profile.variables };

    // Update stats
    this.stats.totalUsers++;
    this.stats.profileCounts[profile.name]++;
    this.updatePercentages();

    return {
      profileName: profile.name,
      userData,
      variables,
      generatedValues,
    };
  }

  /**
   * Select a profile based on weighted random distribution
   */
  private selectProfile(): NormalizedProfile {
    const random = Math.random();

    for (const profile of this.normalizedProfiles) {
      if (random <= profile.cumulativeWeight) {
        return profile;
      }
    }

    // Fallback to last profile (should not happen)
    return this.normalizedProfiles[this.normalizedProfiles.length - 1];
  }

  /**
   * Get next user data from profile (round-robin)
   */
  private getNextUserData(profileName: string): UserData {
    const data = this.userDataCache.get(profileName) || [{}];
    const currentIndex = this.userIndexes.get(profileName) || 0;

    const userData = data[currentIndex % data.length];

    // Advance index
    this.userIndexes.set(profileName, currentIndex + 1);

    return { ...userData };
  }

  /**
   * Generate dynamic values based on profile generators
   */
  private generateValues(profile: Profile): Record<string, unknown> {
    const generated: Record<string, unknown> = {};

    if (!profile.generators) return generated;

    for (const [name, generator] of Object.entries(profile.generators)) {
      generated[name] = this.executeGenerator(generator, profile.name, name);
    }

    return generated;
  }

  /**
   * Execute a single generator
   */
  private executeGenerator(
    generator: Generator,
    profileName: string,
    generatorName: string
  ): unknown {
    switch (generator.type) {
      case 'uuid':
        return uuidv4();

      case 'timestamp':
        return Date.now();

      case 'random':
        return this.generateRandom(generator);

      case 'sequence':
        return this.generateSequence(generator, `${profileName}:${generatorName}`);

      case 'faker':
        return this.generateFaker(generator);

      default:
        throw new Error(`Unknown generator type: ${generator.type}`);
    }
  }

  /**
   * Generate random value
   */
  private generateRandom(generator: Generator): number | string {
    const options = generator.options || {};

    if (options.charset) {
      // Random string
      const length = options.length || 10;
      const charset = options.charset;
      let result = '';
      for (let i = 0; i < length; i++) {
        result += charset[Math.floor(Math.random() * charset.length)];
      }
      return result;
    }

    // Random number
    const min = options.min ?? 0;
    const max = options.max ?? 100;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Generate sequence value
   */
  private generateSequence(generator: Generator, key: string): number {
    const options = generator.options || {};
    const start = options.start ?? 1;
    const step = options.step ?? 1;

    let current = this.sequenceCounters.get(key);
    if (current === undefined) {
      current = start;
    } else {
      current += step;
    }

    this.sequenceCounters.set(key, current);
    return current;
  }

  /**
   * Generate faker value
   */
  private generateFaker(generator: Generator): unknown {
    const options = generator.options || {};
    const method = options.method;

    if (!method) {
      throw new Error('Faker generator requires "method" option');
    }

    // Navigate to faker method (e.g., "person.firstName" or "phone.number")
    const parts = method.split('.');
    let fn: unknown = faker;

    for (const part of parts) {
      if (fn && typeof fn === 'object' && part in fn) {
        fn = (fn as Record<string, unknown>)[part];
      } else {
        throw new Error(`Unknown faker method: ${method}`);
      }
    }

    if (typeof fn !== 'function') {
      throw new Error(`Faker method is not a function: ${method}`);
    }

    // Call with args if provided
    const args = options.args || [];
    return fn.apply(null, args as unknown[]);
  }

  /**
   * Update percentage statistics
   */
  private updatePercentages(): void {
    if (this.stats.totalUsers === 0) return;

    for (const profile of this.config.profiles) {
      this.stats.profilePercentages[profile.name] =
        (this.stats.profileCounts[profile.name] / this.stats.totalUsers) * 100;
    }
  }

  /**
   * Get distribution statistics
   */
  getStats(): ProfileDistributionStats {
    return { ...this.stats };
  }

  /**
   * Get target distribution (configured weights)
   */
  getTargetDistribution(): Record<string, number> {
    const distribution: Record<string, number> = {};
    for (const profile of this.normalizedProfiles) {
      distribution[profile.name] = profile.normalizedWeight * 100;
    }
    return distribution;
  }

  /**
   * Reset distribution state
   */
  reset(): void {
    this.stats.totalUsers = 0;
    for (const profile of this.config.profiles) {
      this.stats.profileCounts[profile.name] = 0;
      this.stats.profilePercentages[profile.name] = 0;
      this.userIndexes.set(profile.name, 0);
    }
    this.sequenceCounters.clear();
  }
}

/**
 * Load and create a profile distributor from file
 */
export async function loadProfileDistributor(
  profilePath: string,
  basePath?: string
): Promise<ProfileDistributor> {
  const absolutePath = isAbsolute(profilePath)
    ? profilePath
    : join(process.cwd(), profilePath);

  if (!existsSync(absolutePath)) {
    throw new Error(`Profile file not found: ${absolutePath}`);
  }

  const content = await readFile(absolutePath, 'utf-8');
  const config = JSON.parse(content) as ProfileConfig;

  // Validate
  const validator = new Validator();
  await validator.initialize();
  const result = validator.validateProfile(config);

  if (!result.valid) {
    throw new Error(formatValidationErrors(result));
  }

  const distributor = new ProfileDistributor(
    config,
    basePath || dirname(absolutePath)
  );
  await distributor.loadData();

  return distributor;
}
