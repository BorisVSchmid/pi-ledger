import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadLedgerConfig, saveReviewerModel } from '../src/ledger/config.js';

describe('ledger config', () => {
  let cwd: string;
  let agentDir: string;

  const writeProject = (value: unknown, name = 'ledger-config.json') => {
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    writeFileSync(join(cwd, '.pi', name), JSON.stringify(value));
  };
  const writeGlobal = (value: unknown, name = 'ledger-config.json') => {
    writeFileSync(join(agentDir, name), JSON.stringify(value));
  };

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pi-ledger-cwd-'));
    agentDir = mkdtempSync(join(tmpdir(), 'pi-ledger-agent-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it('uses the defaults when no config exists', () => {
    const config = loadLedgerConfig(cwd, agentDir);
    expect(config).toEqual(defaultConfig());
    expect(config.autoEnable).toBe(true);
  });

  it('merges nested keys over defaults', () => {
    writeProject({
      reviewer: { model: 'anthropic/x', triggers: { onBreakpoint: false } },
      files: { modelFiles: ['stan/*.stan'] },
    });
    const config = loadLedgerConfig(cwd, agentDir);
    expect(config.reviewer.model).toBe('anthropic/x');
    expect(config.reviewer.triggers.onBreakpoint).toBe(false);
    expect(config.reviewer.triggers.onRegisterChange).toBe(true);
    expect(config.files.modelFiles).toEqual(['stan/*.stan']);
    expect(config.files.ledger).toBe('MEMENTO.md');
  });

  it('project config wins over the global file', () => {
    writeGlobal({ monitor: { cjkRatioMax: 0.5 } });
    writeProject({ autoEnable: false });
    expect(loadLedgerConfig(cwd, agentDir).autoEnable).toBe(false);
    expect(loadLedgerConfig(cwd, agentDir).monitor.cjkRatioMax).toBe(0.01);
  });

  it('falls back to the global file when the project has none', () => {
    writeGlobal({ autoEnable: false });
    expect(loadLedgerConfig(cwd, agentDir).autoEnable).toBe(false);
  });

  it('reads the legacy supervisor-config.json and its supervisor model', () => {
    writeProject(
      { mode: 'ledger', model: { provider: 'openai', modelId: 'gpt-5' } },
      'supervisor-config.json'
    );
    expect(loadLedgerConfig(cwd, agentDir).reviewer.model).toBe('openai/gpt-5');
    writeProject({ reviewer: { model: 'anthropic/y' } });
    expect(loadLedgerConfig(cwd, agentDir).reviewer.model).toBe('anthropic/y');
  });

  it('ignores wrong types, unknown keys and invalid JSON', () => {
    writeProject({ mode: 'chaos', reviewer: { maxTokens: 'lots' }, files: { modelFiles: [1] } });
    const config = loadLedgerConfig(cwd, agentDir);
    expect('mode' in config).toBe(false);
    expect(config.reviewer.maxTokens).toBe(16000);
    expect(config.files.modelFiles).toEqual(defaultConfig().files.modelFiles);

    writeFileSync(join(cwd, '.pi', 'ledger-config.json'), '{ not json');
    writeGlobal({ autoEnable: false });
    expect(loadLedgerConfig(cwd, agentDir).autoEnable).toBe(false);
  });

  it('saves the reviewer model without touching other keys', () => {
    writeProject({ autoEnable: false, reviewer: { thinking: 'low' } });
    const file = saveReviewerModel(cwd, 'anthropic/z');
    const saved = JSON.parse(readFileSync(file, 'utf-8'));
    expect(saved).toEqual({
      autoEnable: false,
      reviewer: { thinking: 'low', model: 'anthropic/z' },
    });
    expect(loadLedgerConfig(cwd, agentDir).reviewer.model).toBe('anthropic/z');
  });
});
