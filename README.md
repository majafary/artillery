# Shield Artillery

**A JSON-driven API performance testing framework built on Artillery.io for Node.js.**

Define complex API orchestration flows as declarative JSON configurations. No code required for testers - just configure journeys, user profiles, and environments.

## Why Shield Artillery?

| Challenge | Shield Artillery Solution |
|-----------|---------------------------|
| Complex API flows need code changes | Define flows as JSON configurations |
| Hard to test conditional paths (MFA, errors) | Declarative branching based on API responses |
| Test data management is scattered | Centralized user profiles with weighted distribution |
| Environment switching is error-prone | Layered configuration: base → environment → CLI |
| Reports aren't shareable | Markdown + HTML reports with step-level metrics |

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Core Concepts](#core-concepts)
- [Understanding Variables](#understanding-variables)
- [Project Structure](#project-structure)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration Reference](#configuration-reference)
- [CLI Commands](#cli-commands)
- [How It Works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CONFIGURATION LAYER                          │
│                                                                      │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│   │   Journey    │  │   Profile    │  │ Environment  │   CLI Args   │
│   │    JSON      │  │    JSON      │  │    JSON      │              │
│   └──────────────┘  └──────────────┘  └──────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         CORE ENGINE                                  │
│                                                                      │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│   │   Journey    │  │    Flow      │  │   Profile    │              │
│   │   Loader     │  │   Engine     │  │ Distributor  │              │
│   │  (validate)  │  │  (branch)    │  │  (users)     │              │
│   └──────────────┘  └──────────────┘  └──────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      ARTILLERY INTEGRATION                           │
│                                                                      │
│   Journey JSON  ──►  Script Generator  ──►  Artillery YAML          │
│                                                                      │
│   Processor Hooks:                                                   │
│   • beforeRequest: Variable interpolation, header merging           │
│   • afterResponse: Data extraction, branch evaluation               │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          REPORTING                                   │
│                                                                      │
│   ┌──────────────┐  ┌──────────────┐                                │
│   │   Markdown   │  │     HTML     │   Step-level metrics           │
│   │   Reporter   │  │   Reporter   │   Threshold validation         │
│   └──────────────┘  └──────────────┘                                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Core Concepts

### Journey
A **journey** is a sequence of API calls representing a user flow. For example, a login journey might include: authenticate → get profile → fetch dashboard.

```json
{
  "id": "user-login",
  "name": "User Login Flow",
  "steps": [...]
}
```

### Step
A **step** is a single API request within a journey. Steps can:
- Extract values from responses (for use in subsequent steps)
- Branch to different paths based on response content
- Add think time between requests

```json
{
  "id": "authenticate",
  "request": { "method": "POST", "url": "/login", "json": {...} },
  "extract": [{ "path": "$.token", "as": "authToken" }],
  "branches": [{ "condition": {...}, "goto": "mfa-flow" }]
}
```

### Profile
A **profile** defines a group of test users with weighted distribution. This simulates realistic user behavior where some users might be premium, others free-tier.

```json
{
  "profiles": [
    { "name": "regular-users", "weight": 70, "dataSource": "./regular.csv" },
    { "name": "premium-users", "weight": 30, "dataSource": "./premium.csv" }
  ]
}
```

### Environment
An **environment** defines where to run tests (target URL), how much load to generate (phases), and what constitutes success (thresholds).

```json
{
  "name": "staging",
  "target": { "baseUrl": "https://api.staging.example.com" },
  "load": { "phases": [{ "duration": "5m", "arrivalRate": 20 }] },
  "thresholds": { "p95ResponseTime": 500 }
}
```

---

## Understanding Variables

Variables are placeholders (`{{variableName}}`) that get replaced with actual values at runtime. There are **three sources** of variables:

```
┌─────────────────────────────────────────────────────────────────────┐
│                       WHERE VARIABLES COME FROM                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. USER DATA (from CSV)              2. EXTRACTED FROM RESPONSES   │
│     ┌─────────────────────┐              ┌─────────────────────┐    │
│     │ users.csv:          │              │ API Response:       │    │
│     │ email,password      │              │ {"token":"abc123"}  │    │
│     │ john@x.com,pass123  │              └──────────┬──────────┘    │
│     └──────────┬──────────┘                         │               │
│                │                                    │ extract:      │
│                │                                    │ path: $.token │
│                │                                    │ as: authToken │
│                ▼                                    ▼               │
│     ┌───────────────────────────────────────────────────────────┐   │
│     │                   VARIABLE CONTEXT                         │   │
│     │                                                            │   │
│     │   user.email = "john@x.com"      ◄── from CSV column      │   │
│     │   user.password = "pass123"      ◄── from CSV column      │   │
│     │   authToken = "abc123"           ◄── extracted from API   │   │
│     │   $uuid = "550e8400-e29b..."     ◄── built-in generator   │   │
│     │                                                            │   │
│     └───────────────────────────────────────────────────────────┘   │
│                               │                                      │
│                               ▼                                      │
│     ┌───────────────────────────────────────────────────────────┐   │
│     │                    NEXT REQUEST                            │   │
│     │   POST /api/profile                                        │   │
│     │   Authorization: Bearer {{authToken}}                      │   │
│     │   Body: {"email": "{{user.email}}"}                        │   │
│     └───────────────────────────────────────────────────────────┘   │
│                                                                      │
│  3. BUILT-IN GENERATORS                                             │
│     {{$uuid}}         → "550e8400-e29b-41d4-a716-446655440000"     │
│     {{$timestamp}}    → 1699900000000                               │
│     {{$isoTimestamp}} → "2024-01-15T10:30:00.000Z"                  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Complete Example: CSV → Profile → Journey → Extract

**Step 1: Create a CSV file with test user data**

```csv
email,password
john@example.com,SecurePass123!
jane@example.com,SecurePass456!
```

Each column header becomes accessible as `{{user.columnName}}`.

**Step 2: Profile references the CSV file**

```json
{
  "id": "test-users",
  "profiles": [{
    "name": "standard-users",
    "weight": 100,
    "dataSource": "./data/users.csv"
  }]
}
```

When a virtual user starts, they get assigned a row from the CSV. That row's data is available as `{{user.email}}`, `{{user.password}}`, etc.

**Step 3: Journey uses user data and extracts response values**

```json
{
  "id": "login",
  "name": "Login Step",
  "request": {
    "method": "POST",
    "url": "/v1/login",
    "json": {
      "username": "{{user.email}}",
      "password": "{{user.password}}"
    }
  },
  "extract": [
    {
      "path": "$.access_token",
      "as": "authToken"
    }
  ]
}
```

At runtime:
- `{{user.email}}` → replaced with `"john@example.com"` (from CSV)
- `{{user.password}}` → replaced with `"SecurePass123!"` (from CSV)
- After the response, `$.access_token` is extracted and stored as `authToken`

**Step 4: Subsequent steps use the extracted value**

```json
{
  "id": "get-profile",
  "name": "Get User Profile",
  "request": {
    "method": "GET",
    "url": "/v1/profile",
    "headers": {
      "Authorization": "Bearer {{authToken}}"
    }
  }
}
```

`{{authToken}}` → replaced with the token extracted from the login response.

### What Does `extract` Do?

`extract` pulls values from an API response and stores them as variables for use in subsequent steps.

```
API Response:                          Extract Config:
{                                      [
  "access_token": "eyJhbGciOi...",       {
  "user": {                                "path": "$.access_token",
    "id": 12345,                           "as": "authToken"
    "name": "John"                       },
  },                                     {
  "otp_methods": [                         "path": "$.user.id",
    { "option_id": "sms-1" },              "as": "userId"
    { "option_id": "email-2" }           },
  ]                                      {
}                                          "path": "$.otp_methods[0].option_id",
                                           "as": "otpOptionId"
                                         }
                                       ]

Result (stored in variable context):
  authToken = "eyJhbGciOi..."
  userId = 12345
  otpOptionId = "sms-1"
```

| Extract Property | Description | Example |
|------------------|-------------|---------|
| `path` | JSONPath expression to locate the value | `$.data.id`, `$.items[0].name`, `$.user.profile.email` |
| `as` | Variable name to store the extracted value | `authToken`, `userId`, `transactionId` |
| `type` | Extraction method (default: `json`) | `json`, `header`, `regex` |
| `default` | Fallback value if extraction fails | `null`, `"unknown"`, `0` |

### JSONPath Quick Reference

| JSONPath | Meaning | Example Response | Result |
|----------|---------|------------------|--------|
| `$.token` | Root-level field | `{"token": "abc"}` | `"abc"` |
| `$.user.id` | Nested field | `{"user": {"id": 123}}` | `123` |
| `$.items[0]` | First array element | `{"items": ["a", "b"]}` | `"a"` |
| `$.items[0].id` | Field in first array element | `{"items": [{"id": 1}]}` | `1` |
| `$.data[*].name` | All names in array | `{"data": [{"name": "A"}, {"name": "B"}]}` | `["A", "B"]` |

### Profile Variables & Generators

In addition to CSV data and extracted values, you can define **static variables** and **dynamic generators** in your profile configuration.

#### Static Variables vs Dynamic Generators

| Aspect | Static Variables | Generators |
|--------|-----------------|------------|
| **When evaluated** | Once at profile load | Fresh value per virtual user/request |
| **Use case** | User type flags, static config | Dynamic IDs, timestamps, random values |
| **Example** | `"requiresMfa": true` | `"deviceId": { "type": "uuid" }` |

#### Generator Types Reference

| Type | Output | Use Case | Example Config |
|------|--------|----------|----------------|
| `uuid` | UUID v4 string | Unique correlation IDs, device IDs | `{ "type": "uuid" }` |
| `timestamp` | Milliseconds since epoch | Cache busting, timestamps | `{ "type": "timestamp" }` |
| `random` | Random number or string | Test data variation | `{ "type": "random", "options": { "min": 1, "max": 100 } }` |
| `sequence` | Incrementing integer | Sequential IDs | `{ "type": "sequence", "options": { "start": 1000, "step": 1 } }` |
| `faker` | Fake data (names, emails, etc.) | Realistic test data | `{ "type": "faker", "options": { "method": "person.firstName" } }` |

#### Profile Configuration Example

```json
{
  "profiles": [
    {
      "name": "mfa-required-users",
      "weight": 15,
      "journey": "./otp-mfa.journey.json",
      "dataSource": "./data/mfa-users.csv",
      "variables": {
        "hasBoundDevice": false,
        "requiresMfa": true
      },
      "generators": {
        "deviceId": { "type": "uuid" },
        "requestTimestamp": { "type": "timestamp" }
      }
    }
  ]
}
```

At runtime, each virtual user gets:
- `{{user.email}}`, `{{user.password}}` from CSV
- `{{hasBoundDevice}}` = `false`, `{{requiresMfa}}` = `true` from static variables
- `{{deviceId}}` = fresh UUID, `{{requestTimestamp}}` = current timestamp from generators

### Journey-per-Profile

Each profile can optionally specify its own journey file. This enables different user types to run completely different API flows while sharing the same load test.

```json
{
  "profiles": [
    {
      "name": "normal-users",
      "weight": 60,
      "journey": "./simple-login.journey.json",
      "dataSource": "./data/normal-users.csv"
    },
    {
      "name": "mfa-required-users",
      "weight": 15,
      "journey": "./otp-mfa.journey.json",
      "dataSource": "./data/mfa-users.csv"
    }
  ]
}
```

**When to use journey-per-profile:**
- Different user types have fundamentally different flows (e.g., MFA vs non-MFA)
- You want to simulate realistic traffic distribution across different use cases

**When to use response-based branching instead:**
- The API response determines the path (stateful behavior)
- Same user might get different responses depending on server state (e.g., device already bound)

---

## Project Structure

```
shield-artillery/
│
├── src/                              # Source code (TypeScript)
│   ├── index.ts                      # CLI entry point (Commander.js)
│   │
│   ├── types/                        # TypeScript type definitions
│   │   ├── journey.types.ts          # Journey, Step, Branch, Extract types
│   │   ├── profile.types.ts          # Profile, UserData, Generator types
│   │   ├── config.types.ts           # FrameworkConfig, EnvironmentConfig
│   │   ├── report.types.ts           # TestReport, StepMetrics types
│   │   └── index.ts                  # Re-exports all types
│   │
│   ├── core/                         # Core framework logic
│   │   ├── journey-loader.ts         # Loads and validates journey JSON files
│   │   ├── flow-engine.ts            # Evaluates branch conditions, determines execution path
│   │   ├── data-extractor.ts         # Extracts values using JSONPath, headers, regex
│   │   ├── profile-distributor.ts    # Weighted random user selection, CSV loading
│   │   └── config-merger.ts          # Merges layered configuration
│   │
│   ├── artillery/                    # Artillery.io integration
│   │   ├── processor.ts              # beforeRequest/afterResponse hooks
│   │   ├── script-generator.ts       # Converts journey → Artillery YAML
│   │   ├── plugin.ts                 # Custom metrics collection plugin
│   │   └── runner.ts                 # Wraps Artillery execution
│   │
│   ├── reporters/                    # Report generation
│   │   ├── markdown-reporter.ts      # Generates shareable .md reports
│   │   ├── html-reporter.ts          # Generates interactive .html reports
│   │   └── report-data-builder.ts    # Aggregates and transforms metrics
│   │
│   └── utils/
│       ├── template.ts               # {{variable}} interpolation engine
│       └── validator.ts              # JSON schema validation (Ajv)
│
├── schemas/                          # JSON validation schemas
│   ├── journey.schema.json           # Validates *.journey.json files
│   ├── profile.schema.json           # Validates *.profile.json files
│   └── environment.schema.json       # Validates *.env.json files
│
├── examples/                         # Example configurations
│   └── ciam-auth/                    # CIAM authentication example
│       ├── simple-login.journey.json # Simple login (bound device)
│       ├── otp-mfa.journey.json      # Full MFA flow with OTP
│       ├── users.profile.json        # User distribution config
│       ├── environments/
│       │   ├── dev.env.json          # Development environment
│       │   └── staging.env.json      # Staging environment
│       └── data/
│           ├── normal-users.csv      # Standard test users
│           ├── bound-users.csv       # Users with bound devices
│           └── mfa-users.csv         # Users requiring MFA
│
├── dist/                             # Compiled JavaScript (generated by npm run build)
├── reports/                          # Generated test reports (created at runtime)
├── package.json
├── tsconfig.json
└── README.md
```

### Where to Put Your Files

| File Type | Recommended Location | Naming Convention | Example |
|-----------|---------------------|-------------------|---------|
| Journey definitions | `journeys/` or project folder | `*.journey.json` | `login.journey.json` |
| User profiles | Same directory as journeys | `*.profile.json` | `users.profile.json` |
| Environment configs | `environments/` subdirectory | `{env}.env.json` | `dev.env.json` |
| User data (CSV/JSON) | `data/` relative to profile | Any | `premium-users.csv` |
| Generated reports | `reports/` | Auto-generated | `report-2024-01-15.md` |

---

## Installation

```bash
# Clone or navigate to the project
cd shield-artillery

# Install dependencies
npm install

# Build TypeScript
npm run build

# Verify installation
node dist/index.js --help
```

---

## Quick Start

### 1. Define a Journey

Create a journey JSON file that describes your API flow:

```json
{
  "id": "login-flow",
  "name": "User Login",
  "defaults": {
    "headers": { "Content-Type": "application/json" }
  },
  "steps": [
    {
      "id": "login",
      "request": {
        "method": "POST",
        "url": "/v1/login",
        "json": {
          "username": "{{user.email}}",
          "password": "{{user.password}}"
        }
      },
      "extract": [
        { "path": "$.access_token", "as": "accessToken" }
      ]
    },
    {
      "id": "get-profile",
      "request": {
        "method": "GET",
        "url": "/v1/profile",
        "headers": {
          "Authorization": "Bearer {{accessToken}}"
        }
      }
    }
  ]
}
```

### 2. Create User Data

Create a CSV file with test user credentials:

```csv
email,password
user1@example.com,TestPass123!
user2@example.com,TestPass123!
user3@example.com,TestPass123!
```

### 3. Configure User Profiles

Define how users are distributed:

```json
{
  "id": "test-users",
  "profiles": [
    {
      "name": "standard-users",
      "weight": 100,
      "dataSource": "./data/users.csv"
    }
  ]
}
```

### 4. Set Up Environment

Define target URL and load configuration:

```json
{
  "name": "staging",
  "target": {
    "baseUrl": "https://api.staging.example.com"
  },
  "load": {
    "phases": [
      { "duration": "1m", "arrivalRate": 5, "name": "warm-up" },
      { "duration": "5m", "arrivalRate": 20, "name": "sustained" }
    ]
  },
  "thresholds": {
    "p95ResponseTime": 500,
    "maxErrorRate": 0.01
  }
}
```

### 5. Run the Test

```bash
# Validate your configuration
node dist/index.js validate ./login.journey.json

# Dry run (see generated Artillery script)
node dist/index.js run ./login.journey.json \
  -e ./environments/staging.env.json \
  -p ./users.profile.json \
  --dry-run

# Execute the load test
node dist/index.js run ./login.journey.json \
  -e ./environments/staging.env.json \
  -p ./users.profile.json \
  -o ./reports
```

---

## Configuration Reference

### Journey Schema

```typescript
interface Journey {
  id: string;                    // Unique identifier (required)
  name: string;                  // Display name (required)
  description?: string;          // Optional description
  version?: string;              // Version string
  defaults?: {
    headers?: Record<string, string>;  // Default headers for all requests
    timeout?: number;                   // Default timeout in ms
    thinkTime?: { min: number; max: number };  // Default think time
  };
  steps: Step[];                 // Array of steps (required, min 1)
}
```

### Step Schema

```typescript
interface Step {
  id: string;                    // Unique step identifier (required)
  name?: string;                 // Display name
  request: {
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    url: string;                 // URL path (supports {{variables}})
    headers?: Record<string, string>;
    json?: object;               // JSON body
    body?: string;               // Raw body
    expect?: {
      statusCode: number | number[];  // Expected status codes
    };
  };
  extract?: Array<{
    path: string;                // JSONPath expression (e.g., "$.data.id")
    as: string;                  // Variable name to store extracted value
    type?: "json" | "header" | "regex";  // Extraction type (default: json)
    default?: any;               // Default value if extraction fails
  }>;
  branches?: Array<{
    condition: {
      field: string;             // JSONPath to evaluate
      eq?: any;                  // Equal to
      ne?: any;                  // Not equal to
      gt?: number;               // Greater than
      gte?: number;              // Greater than or equal
      lt?: number;               // Less than
      lte?: number;              // Less than or equal
      contains?: string;         // String contains
      matches?: string;          // Regex match
      exists?: boolean;          // Field exists
      in?: any[];                // Value in array
    };
    goto: string;                // Step ID to jump to
  }>;
  thinkTime?: { min: number; max: number };  // Think time in seconds
  onSuccess?: string;            // Next step ID (for linear flows)
}
```

### Profile Schema

```typescript
interface ProfileConfig {
  id: string;                    // Unique identifier (required)
  name?: string;                 // Display name
  profiles: Array<{
    name: string;                // Profile name (required)
    weight: number;              // Weight 1-100 (required)
    dataSource?: string;         // Path to CSV/JSON file
    data?: object[];             // Inline data array
    variables?: Record<string, any>;  // Static variables
    generators?: Record<string, {
      type: "uuid" | "timestamp" | "random" | "sequence" | "faker";
      options?: {
        // For random:
        min?: number;
        max?: number;
        charset?: string;
        length?: number;
        // For sequence:
        start?: number;
        step?: number;
        // For faker:
        method?: string;         // e.g., "person.firstName", "phone.number"
        args?: any[];
      };
    }>;
  }>;
}
```

### Environment Schema

```typescript
interface EnvironmentConfig {
  name: string;                  // Environment name (required)
  description?: string;
  variables?: Record<string, any>;  // Environment variables
  target: {
    baseUrl: string;             // Target URL (required)
    timeout?: number;            // HTTP timeout in ms
  };
  load: {
    phases: Array<{
      name?: string;             // Phase name
      duration: string;          // Duration (e.g., "1m", "30s")
      arrivalRate?: number;      // VUs per second (use this OR arrivalCount)
      arrivalCount?: number;     // Fixed number of VUs for the phase
      rampTo?: number;           // Ramp to this rate (with arrivalRate)
      maxVusers?: number;        // Maximum concurrent VUs
      pause?: string;            // Pause between phases (e.g., "10s")
    }>;
  };
  thresholds?: {
    p50ResponseTime?: number;    // p50 (median) latency threshold in ms
    p95ResponseTime?: number;    // p95 latency threshold in ms
    p99ResponseTime?: number;    // p99 latency threshold in ms
    maxResponseTime?: number;    // Maximum response time threshold in ms
    maxErrorRate?: number;       // Max error rate (0.01 = 1%)
    minThroughput?: number;      // Minimum requests per second
  };
  http?: {
    pool?: number;               // Connection pool size
    timeout?: number;            // HTTP timeout
    maxRedirects?: number;       // Max redirects to follow
  };
}
```

### Variable Interpolation

Use `{{variable}}` syntax anywhere in requests:

| Pattern | Description | Example |
|---------|-------------|---------|
| `{{user.fieldName}}` | User data from CSV/profile | `{{user.email}}` |
| `{{variableName}}` | Extracted or generated value | `{{accessToken}}` |
| `{{env.VARIABLE}}` | Environment variable | `{{env.API_KEY}}` |
| `{{$uuid}}` | Generate UUID | `{{$uuid}}` |
| `{{$timestamp}}` | Current timestamp (ms) | `{{$timestamp}}` |
| `{{$isoTimestamp}}` | ISO timestamp | `{{$isoTimestamp}}` |

---

## CLI Commands

### run

Execute a load test from a journey configuration.

```bash
node dist/index.js run <journey> [options]

Options:
  -e, --environment <name>    Environment name or path to env config (default: localhost:3000)
  -p, --profiles <path>       Path to user profiles config
  -o, --output <dir>          Output directory for reports (default: "./reports")
  -f, --format <formats...>   Report formats: markdown, html, json (default: markdown, html)
  --dry-run                   Generate Artillery script without executing
  -v, --verbose               Verbose output (shows Artillery's raw output)
  -q, --quiet                 Minimal output (no progress bar)
  --debug                     Log HTTP request/response details to debug-*.log file
  --sample-all                Log all requests to CSV (warning: large files for big tests)
```

**Environment resolution**: The `-e` flag accepts either:
- A file path: `-e ./environments/staging.env.json`
- An environment name: `-e staging` (searches `./environments/staging.env.json`, `./staging.env.json`, `./config/staging.json`)

### validate

Validate a journey configuration against the schema.

```bash
node dist/index.js validate <journey>

# Output shows:
# - Schema validation result
# - Number of steps
# - Possible execution paths
```

### generate

Generate Artillery script from journey (for debugging/inspection).

```bash
node dist/index.js generate <journey> [options]

Options:
  -e, --environment <path>    Environment config
  -p, --profiles <path>       User profiles
  -o, --output <path>         Output path for script
```

### list

List available journeys in a directory.

```bash
node dist/index.js list [options]

Options:
  -d, --dir <path>    Directory to search (default: "./journeys")
```

---

## How It Works

### Conditional Branching

Artillery doesn't natively support conditional jumps between steps. Shield Artillery implements a **state machine pattern**:

1. **All steps are defined** in the Artillery scenario flow
2. **Each step has a guard function** (`ifTrue: shouldExecuteStep_<id>`)
3. **afterResponse hook** evaluates branch conditions and sets `__nextStep`
4. **Guard functions skip steps** that aren't in the current execution path

```
Journey Definition:              Runtime Execution:

┌─────────┐                      ┌─────────┐
│  login  │ ─── MFA_REQUIRED ─►  │  login  │ (always executes)
└─────────┘                      └────┬────┘
     │                                │
     │ SUCCESS                        │ __nextStep = "mfa-initiate"
     ▼                                ▼
┌─────────┐                      ┌─────────┐
│dashboard│                      │mfa-init │ (guard passes)
└─────────┘                      └────┬────┘
                                      │ __nextStep = "mfa-verify"
┌─────────┐                           ▼
│mfa-init │ ◄─────────────────── ┌─────────┐
└─────────┘                      │mfa-vrfy │ (guard passes)
     │                           └────┬────┘
     ▼                                │ __nextStep = "dashboard"
┌─────────┐                           ▼
│mfa-vrfy │                      ┌─────────┐
└─────────┘                      │dashboard│ (guard passes)
     │                           └─────────┘
     ▼
┌─────────┐
│dashboard│
└─────────┘
```

### Data Extraction

The `DataExtractor` supports multiple extraction types:

| Type | Path Format | Example |
|------|-------------|---------|
| JSON (default) | JSONPath | `$.data.user.id`, `$.items[0].name` |
| Header | Header name | `X-Request-Id`, `Authorization` |
| Regex | Regex pattern | `token=([^&]+)` |

### User Distribution

The `ProfileDistributor` uses weighted random selection:

```
Configured weights:           Actual distribution (1000 users):
- regular-users: 70           - regular-users: ~700 users
- premium-users: 30           - premium-users: ~300 users
```

Users cycle through their data source (round-robin) ensuring all test data is used.

---

## Troubleshooting

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| "Journey path is required" | Missing journey argument | Provide path: `run ./journey.json` |
| "Environment target baseUrl is required" | Missing or invalid env config | Check `target.baseUrl` in env JSON |
| "Profile file not found" | Invalid profile path | Check `-p` path is correct |
| "Data source not found" | CSV path incorrect | Paths are relative to profile file location |

### Variable Not Interpolated

If `{{variable}}` appears in requests instead of the value:

1. **Check extraction path**: Use JSONPath tester to verify path
2. **Check variable name**: Extraction `as` must match usage
3. **Check step order**: Variables must be extracted before use

### Branch Not Taken

If conditional branching isn't working:

1. **Verify condition field**: Use JSONPath tester on actual response
2. **Check operator**: `eq` for exact match, `contains` for partial
3. **Inspect response**: Add `--verbose` to see actual API responses

### CSV Logging Limitations

When using the `--debug` flag, Shield Artillery generates a CSV file (`request-details-*.csv`) with HTTP request and response details. However, **network-level errors are not captured in the CSV file**.

**Why network errors are not logged to CSV:**
- CSV logging only happens when an HTTP response is received
- Network errors occur at the TCP/connection level, before an HTTP response exists
- Without a response object, there's no data to log to the CSV

**Network errors NOT captured in CSV:**
- `ECONNREFUSED` - Connection refused (server not listening)
- `ETIMEDOUT` - Connection timeout
- `EHOSTUNREACH` - Host unreachable
- `ENOTFOUND` - DNS lookup failed
- `ENETUNREACH` - Network unreachable
- `socket hang up` - Connection dropped
- `ESOCKETTIMEDOUT` - Socket timeout
- `EPROTO` - Protocol error
- `EPIPE` - Broken pipe

**Where to find network errors:**
- These errors ARE captured in the debug log file (`debug-*.log`) when using `--debug`
- Artillery's JSON report (`report-*.json`) also includes error counts
- Run with `--verbose` to see error details in console output

**What IS logged to CSV:**
- All successful HTTP responses (2xx status codes)
- Client errors (4xx status codes)
- Server errors (5xx status codes)
- Any response that returns an HTTP status code

```bash
# Example: Debug network connectivity issues
node dist/index.js run journey.json -e env.json --debug --verbose

# Check debug log for network errors
grep -i "ECONNREFUSED\|ETIMEDOUT\|EHOSTUNREACH" ./reports/debug-*.log
```

### Debugging Tips

```bash
# Generate script without running to inspect
node dist/index.js run journey.json -e env.json --dry-run

# Validate journey to see execution paths
node dist/index.js validate journey.json

# Run with verbose output (shows Artillery's raw metrics)
node dist/index.js run journey.json -e env.json -v

# Debug HTTP request/response details (writes to debug-*.log)
node dist/index.js run journey.json -e env.json --debug

# Combine verbose and debug for maximum visibility
node dist/index.js run journey.json -e env.json -v --debug
```

---

## Contributing

### Adding New Generators

Edit `src/core/profile-distributor.ts`:

```typescript
private executeGenerator(generator: Generator, ...): unknown {
  switch (generator.type) {
    // Add new case:
    case 'custom':
      return this.generateCustom(generator);
    // ...
  }
}
```

### Adding New Condition Operators

Edit `src/core/flow-engine.ts`:

```typescript
private evaluateCondition(condition: Condition, value: unknown): boolean {
  // Add new operator:
  if ('myOperator' in condition) {
    return this.evaluateMyOperator(value, condition.myOperator);
  }
  // ...
}
```

### Adding New Report Formats

1. Create new reporter in `src/reporters/`
2. Implement the `Reporter` interface
3. Register in `src/index.ts` CLI handler

---

## Example: CIAM Authentication with MFA

See `examples/ciam-auth/` for a complete working example:

```bash
# Validate the simple login journey
node dist/index.js validate ./examples/ciam-auth/simple-login.journey.json

# Validate the OTP MFA journey
node dist/index.js validate ./examples/ciam-auth/otp-mfa.journey.json

# Dry run to see generated script
node dist/index.js run ./examples/ciam-auth/simple-login.journey.json \
  -e ./examples/ciam-auth/environments/dev.env.json \
  -p ./examples/ciam-auth/users.profile.json \
  --dry-run

# Execute the test with profiles
node dist/index.js run ./examples/ciam-auth/simple-login.journey.json \
  -e ./examples/ciam-auth/environments/dev.env.json \
  -p ./examples/ciam-auth/users.profile.json \
  -o ./reports

# Quick local test (no profile, uses default localhost:3000)
node dist/index.js run ./examples/ciam-auth/simple-login.journey.json -e local
```

The example includes:
- **Simple login journey**: For users with bound devices (no MFA)
- **OTP MFA journey**: Full flow with initiate → fetch OTP → verify → device bind
- **Three-tier user distribution**: 60% normal users, 25% bound-device users, 15% MFA users
- **Profile-specific journeys**: Each profile can run different journeys
- **Dev environment config**: Configured for 1.2M calls/day target volume

---

## License

MIT
