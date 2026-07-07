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
      resolveMarkdownPath('introduction/local-quickstart', '/intro/local-quickstart'),
    ).toBe('/intro/local-quickstart.md');
  });

  it('treats root slug as empty and falls back to doc id', () => {
    expect(resolveMarkdownPath('intro', '/')).toBe('/docs/intro.md');
  });

  it('uses simple slug under docs', () => {
    expect(resolveMarkdownPath('setup/cli', 'cli')).toBe('/docs/cli.md');
  });
});
