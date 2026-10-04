import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadLedgerConfig } from '../src/config.js';
import { snapshotFiles } from '../src/monitor.js';

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
      reviewer: { model: 'anthropic/x', thinking: 'low' },
      files: { modelFiles: ['stan/*.stan'] },
    });
    const config = loadLedgerConfig(cwd, agentDir);
    expect(config.reviewer.model).toBe('anthropic/x');
    expect(config.reviewer.thinking).toBe('low');
    expect(config.reviewer.fallbackModel).toBeNull();
    expect(config.files.modelFiles).toEqual(['stan/*.stan']);
    expect(config.files.ledger).toBe('MEMENTO.md');
  });

  it('project config wins over the global file', () => {
    writeGlobal({ files: { ledger: 'NOTES.md' } });
    writeProject({ autoEnable: false });
    expect(loadLedgerConfig(cwd, agentDir).autoEnable).toBe(false);
    expect(loadLedgerConfig(cwd, agentDir).files.ledger).toBe('MEMENTO.md');
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
    writeProject({ mode: 'chaos', reviewer: { thinking: 3 }, files: { modelFiles: [1] } });
    const config = loadLedgerConfig(cwd, agentDir);
    expect('mode' in config).toBe(false);
    expect(config.reviewer.thinking).toBe('high');
    expect(config.files.modelFiles).toEqual(defaultConfig().files.modelFiles);

    writeFileSync(join(cwd, '.pi', 'ledger-config.json'), '{ not json');
    writeGlobal({ autoEnable: false });
    expect(loadLedgerConfig(cwd, agentDir).autoEnable).toBe(false);
  });

  it('default model files include top-level R files and skip archives', async () => {
    mkdirSync(join(cwd, 'R', 'archive'), { recursive: true });
    writeFileSync(join(cwd, 'model.R'), 'x <- 1\n');
    writeFileSync(join(cwd, 'R', 'fit.R'), 'y <- 1\n');
    writeFileSync(join(cwd, 'R', 'archive', 'old.R'), '# @concept P3\n');
    const { files } = defaultConfig();
    const snap = await snapshotFiles(cwd, files.modelFiles, 400_000, files.ignore);
    expect(Object.keys(snap).sort()).toEqual(['R/fit.R', 'model.R']);
  });
});
