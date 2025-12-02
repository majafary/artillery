/**
 * User Profile Types
 * Defines user distribution and data generation for load testing
 */

export interface ProfileConfig {
  id: string;
  name?: string;
  profiles: Profile[];
}

export interface Profile {
  name: string;
  weight: number;
  dataSource?: string;
  data?: UserData[];
  variables?: Record<string, unknown>;
  generators?: Record<string, Generator>;
}

export interface UserData {
  [key: string]: unknown;
}

export interface Generator {
  type: GeneratorType;
  options?: GeneratorOptions;
}

export type GeneratorType = 'uuid' | 'timestamp' | 'random' | 'sequence' | 'faker';

export interface GeneratorOptions {
  // UUID options
  version?: 1 | 4;

  // Random options
  min?: number;
  max?: number;
  length?: number;
  charset?: string;

  // Sequence options
  start?: number;
  step?: number;

  // Faker options
  method?: string;
  locale?: string;
  args?: unknown[];
}

/**
 * Runtime types for profile distribution
 */
export interface UserContext {
  profileName: string;
  userData: UserData;
  variables: Record<string, unknown>;
  generatedValues: Record<string, unknown>;
}

export interface NormalizedProfile extends Profile {
  normalizedWeight: number;
  cumulativeWeight: number;
}

export interface ProfileDistributionStats {
  totalUsers: number;
  profileCounts: Record<string, number>;
  profilePercentages: Record<string, number>;
}
