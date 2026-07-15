import { beforeEach, describe, expect, it } from 'vitest';
import { readDraft, writeDraft } from './storage';

describe('workflow draft storage', () => {
  beforeEach(() => localStorage.clear());

  it('normalizes the complete local workspace URL while preserving checkpoint and thread isolation', () => {
    writeDraft('demo', '/contexts/c/routes/r/stages/s?thread=t&checkpoint=p', 'combined');
    writeDraft('demo', '/contexts/c/routes/r/stages/s?thread=other', 'other thread');

    expect(readDraft('demo', '/contexts/c/routes/r/stages/s?checkpoint=p&thread=t')).toBe('combined');
    expect(readDraft('demo', '/contexts/c/routes/r/stages/s?thread=other')).toBe('other thread');
    expect(readDraft('demo', '/contexts/c/routes/r/stages/s')).toBe('');
  });
});
