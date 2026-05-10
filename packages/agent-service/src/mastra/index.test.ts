import { describe, expect, it, vi } from 'vitest';

vi.mock('@mastra/core', () => ({
  Mastra: vi.fn().mockImplementation((config: unknown) => ({ config })),
}));

vi.mock('@mastra/loggers', () => ({
  PinoLogger: vi.fn().mockImplementation((config: unknown) => ({ config })),
}));

vi.mock('./agents/index.js', () => ({
  intentRouter: { id: 'intentRouter' },
  generalQa: { id: 'defaultGeneralQa' },
  requirementCollector: { id: 'requirementCollector' },
}));

const { Mastra } = await import('@mastra/core');
const { createMastra } = await import('./index.js');
const { intentRouter, requirementCollector } = await import('./agents/index.js');

import type { AgentBundle } from './agents/index.js';

describe('createMastra', () => {
  it('registers injected agent bundle instead of default singleton agents', () => {
    const agents = {
      intentRouter,
      generalQa: { id: 'injectedGeneralQa' },
      requirementCollector,
    } as unknown as AgentBundle;

    createMastra({ agents });

    expect(Mastra).toHaveBeenCalledWith(
      expect.objectContaining({
        agents,
      }),
    );
  });
});
