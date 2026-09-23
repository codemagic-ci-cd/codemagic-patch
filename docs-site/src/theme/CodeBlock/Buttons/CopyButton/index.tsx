import React, {type ReactNode} from 'react';
import {useCodeBlockContext} from '@docusaurus/theme-common/internal';
import CopyButton from '@theme-original/CodeBlock/Buttons/CopyButton';
import type {Props} from '@theme/CodeBlock/Buttons/CopyButton';

const START_STACK_SNIPPETS = [
  'npm install -g @codemagic/patch-cli',
  'cmpatch selfhost local-eval',
];

function trackQuickstartCopy() {
  const plausible = (
    window as Window & {plausible?: (event: string) => void}
  ).plausible;
  plausible?.('Quickstart Copy');
}

export default function CopyButtonWithPlausible(props: Props): ReactNode {
  const {
    metadata: {code},
  } = useCodeBlockContext();
  const isStartStack = START_STACK_SNIPPETS.every((snippet) =>
    code.includes(snippet),
  );

  return (
    <span onClickCapture={isStartStack ? trackQuickstartCopy : undefined}>
      <CopyButton {...props} />
    </span>
  );
}
