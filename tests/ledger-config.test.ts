import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, isLedgerMode, loadLedgerConfig } from '../src/ledger/config.js';

describe('ledger config', () => {
  let cwd: string;
  let agentDir: string;

  const writeProject = (value: unknown) => {
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    writeFileSync(join(cwd, '.pi', 'supervisor-config.json'), JSON.stringify(value));
  };
  const writeGlobal = (value: unknown) => {
    writeFileSync(join(agentDir, 'supervisor-config.json'), JSON.stringify(value));
  };

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pi-ledger-cwd-'));
    agentDir = mkdtempSync(join(tmpdir(), 'pi-ledger-agent-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it('defaults to goal mode when no config exists', () => {
    const config = loadLedgerConfig(cwd, agentDir);
    expect(config).toEqual(defaultConfig());
    expect(isLedgerMode(config)).toBe(false);
  });

  it('keeps goal mode for an existing model-only config', () => {
    writeProject({ model: { provider: 'openai', modelId: 'gpt-4o' } });
    expect(loadLedgerConfig(cwd, agentDir).mode).toBe('goal');
  });

  it('enables ledger mode and merges nested keys over defaults', () => {
    writeProject({
      mode: 'ledger',
      reviewer: { model: 'anthropic/x', triggers: { onBreakpoint: false } },
      files: { modelFiles: ['stan/*.stan'] },
    });
    const config = loadLedgerConfig(cwd, agentDir);
    expect(isLedgerMode(config)).toBe(true);
    expect(config.reviewer.model).toBe('anthropic/x');
    expect(config.reviewer.triggers.onBreakpoint).toBe(false);
    expect(config.reviewer.triggers.onRegisterChange).toBe(true);
    expect(config.files.modelFiles).toEqual(['stan/*.stan']);
    expect(config.files.ledger).toBe('MEMENTO.md');
  });

  it('project config wins over the global file', () => {
    writeGlobal({ mode: 'ledger', monitor: { cjkRatioMax: 0.5 } });
    writeProject({ mode: 'goal' });
    expect(loadLedgerConfig(cwd, agentDir).mode).toBe('goal');
    expect(loadLedgerConfig(cwd, agentDir).monitor.cjkRatioMax).toBe(0.01);
  });

  it('falls back to the global file when the project has none', () => {
    writeGlobal({ mode: 'ledger' });
    expect(loadLedgerConfig(cwd, agentDir).mode).toBe('ledger');
  });

  it('ignores wrong types, unknown modes and invalid JSON', () => {
    writeProject({ mode: 'chaos', reviewer: { maxTokens: 'lots' }, files: { modelFiles: [1] } });
    const config = loadLedgerConfig(cwd, agentDir);
    expect(config.mode).toBe('goal');
    expect(config.reviewer.maxTokens).toBe(16000);
    expect(config.files.modelFiles).toEqual(defaultConfig().files.modelFiles);

    writeFileSync(join(cwd, '.pi', 'supervisor-config.json'), '{ not json');
    writeGlobal({ mode: 'ledger' });
    expect(loadLedgerConfig(cwd, agentDir).mode).toBe('ledger');
  });
});
