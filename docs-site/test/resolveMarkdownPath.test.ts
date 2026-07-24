import {describe, expect, it} from 'vitest';

import {resolveMarkdownPath} from '../src/utils/resolveMarkdownPath';

describe('resolveMarkdownPath', () => {
  it('uses docs id path by default', () => {
    expect(resolveMarkdownPath('introduction/how-it-works', undefined)).toBe(
      '/docs/introduction/how-it-works.md',
    );
  });

  it('uses nested slug path without docs prefix', () => {
    expect(
      resolveMarkdownPath('introduction/how-it-works', '/intro/how-it-works'),
    ).toBe('/intro/how-it-works.md');
  });

  it('treats root slug as empty and falls back to doc id', () => {
    expect(resolveMarkdownPath('intro', '/')).toBe('/docs/intro.md');
  });

  it('uses simple slug under docs', () => {
    expect(resolveMarkdownPath('setup/self-host', 'self-host')).toBe(
      '/docs/self-host.md',
    );
  });
});
