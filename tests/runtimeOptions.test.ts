import { describe, expect, it } from 'vitest';
import { readRuntimeOptions } from '../src/app/runtimeOptions';

describe('readRuntimeOptions', () => {
  it('uses hodsock embed defaults', () => {
    const options = readRuntimeOptions('');
    expect(options.sceneId).toBe('hodsock-gatehouse');
    expect(options.embed).toBe(true);
    expect(options.autorotateOverride).toBeNull();
    expect(options.controlsVisible).toBe(false);
    expect(options.replayButtonVisible).toBe(false);
  });

  it('parses embed and autorotate flags', () => {
    const options = readRuntimeOptions('?scene=demo&embed=1&autorotate=0&controls=1&replayButton=1');
    expect(options.sceneId).toBe('demo');
    expect(options.embed).toBe(true);
    expect(options.autorotateOverride).toBe(false);
    expect(options.controlsVisible).toBe(true);
    expect(options.replayButtonVisible).toBe(true);
  });

  it('normalizes parentOrigin', () => {
    const options = readRuntimeOptions('?parentOrigin=https%3A%2F%2Fexample.com%2Ffoo');
    expect(options.parentOrigin).toBe('https://example.com');
  });

  it('defaults replay button off in embed mode', () => {
    const options = readRuntimeOptions('?embed=1');
    expect(options.replayButtonVisible).toBe(false);
  });

  it('defaults non-default scenes to non-embed mode', () => {
    const options = readRuntimeOptions('?scene=demo');
    expect(options.embed).toBe(false);
    expect(options.controlsVisible).toBe(true);
    expect(options.replayButtonVisible).toBe(false);
  });
});
