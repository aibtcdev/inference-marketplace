/**
 * skill.md's worked example must name a model the chat route will actually
 * serve (#23): same predicate as the router, and no hard-coded fallback model.
 */
import { describe, it, expect } from 'vitest';
import { renderSkillMd } from '../src/skill';
import type { Provider } from '../src/directory';

function provider(over: Partial<Provider>): Provider {
  return {
    id: 'p1',
    name: 'p1',
    endpoint: 'https://example.invalid/v1',
    api: 'openai',
    payoutAddress: 'SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7',
    acceptedToken: 'sBTC',
    pricePerRequest: '5',
    models: [{ id: 'live/model' } as Provider['models'][number]],
    secured: false,
    health: null,
    status: 'live',
    reputation: null,
    registeredAt: '2026-11-01T00:00:00Z',
    ...over,
  } as Provider;
}

const render = (providers: Provider[]) =>
  renderSkillMd({ origin: 'https://gw.example', network: 'mainnet', providers });

describe('skill.md worked example', () => {
  it('uses a routable provider model', () => {
    const md = render([provider({})]);
    expect(md).toContain('"model":"live/model"');
    expect(md).toContain('real and callable right now');
  });

  it.each([
    ['no providers', [] as Provider[]],
    ['only degraded', [provider({ status: 'degraded' })]],
    ['only flagged', [provider({ flagged: true })]],
    ['only unpriced', [provider({ pricePerRequest: null })]],
  ])('with %s: no fabricated model id, and says nothing is live', (_label, providers) => {
    const md = render(providers);
    // Section A's call examples (curl body and execute_x402_endpoint data).
    expect(md).not.toContain('"model":"Qwen/Qwen2.5-7B-Instruct"');
    expect(md).not.toContain('model: "Qwen/Qwen2.5-7B-Instruct"');
    expect(md).not.toContain('"model":"live/model"');
    expect(md).toContain('<model id from GET /v1/models>');
    expect(md).toContain('No provider is live right now');
    expect(md).not.toContain('real and callable right now');
    // The models table agrees with the banner: no unroutable rows.
    expect(md).not.toContain('| `live/model` |');
    expect(md).toContain('no live providers yet');
  });

  it('skips an unroutable provider and picks the next routable one', () => {
    const md = render([
      provider({ id: 'a', status: 'degraded', models: [{ id: 'degraded/model' } as Provider['models'][number]] }),
      provider({ id: 'b' }),
    ]);
    expect(md).toContain('"model":"live/model"');
    expect(md).not.toContain('"model":"degraded/model"');
    expect(md).toContain('| `live/model` | b |');
    expect(md).not.toContain('`degraded/model`');
  });
});
