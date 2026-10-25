import type { PriceCatalog } from '../budget.js';
import type { ProviderSettings } from '../config.js';
import type { ErrorCode } from '../errors.js';
import type { PromptBundle } from '../prompts.js';
import type { RuntimeSettings } from '../runtime-settings.js';
import type { SupportResponse } from '../schemas.js';
import type { CapturedOutput, RunTrace } from '../telemetry.js';

export interface RunReportOptions {
  directory?: string;
  text: string;
  normalizedText: string;
  inputSource: 'text' | 'stdin';
  provider: ProviderSettings['provider'];
  model: string;
  prompts: PromptBundle;
  runtimeSettings: RuntimeSettings;
  prices: PriceCatalog;
}
export interface RunReportResult {
  response: SupportResponse | null;
  trace: RunTrace | null;
  error: { code: ErrorCode; message: string } | null;
  rawOutputs: CapturedOutput[];
}
export interface RunReport extends RunReportResult {
  formatVersion: 2;
  reportId: string;
  runId: string | null;
  startedAt: string;
  finishedAt: string | null;
  state: 'running' | 'finished';
  provenance: { source: 'cli'; omitted: string[] };
  application: {
    name: string;
    version: string;
    nodeVersion: string;
    sdkVersions: Record<string, string>;
  };
  ticket: { id: string; text: string; normalizedText: string };
  invocation: {
    workingDirectory: string;
    inputSource: 'text' | 'stdin';
    provider: ProviderSettings['provider'];
    model: string;
    promptVersion: string;
  };
  configuration: {
    runtimeSettings: RuntimeSettings;
    prompts: PromptBundle;
    schemas: { response: Record<string, unknown>; moderation: Record<string, unknown> };
    prices: { version: string; hash: string; source: string };
  };
  humanReview: { status: 'pending'; notes: string[] };
}
