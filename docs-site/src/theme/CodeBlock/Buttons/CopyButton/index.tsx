import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import {useCodeBlockContext} from '@docusaurus/theme-common/internal';
import CopyButton from '@theme-original/CodeBlock/Buttons/CopyButton';
import type {Props} from '@theme/CodeBlock/Buttons/CopyButton';

const START_STACK_SNIPPET =
  'git clone https://github.com/codemagic-ci-cd/codemagic-patch.git';

export default function CopyButtonWithPlausible(props: Props): ReactNode {
  const {
    metadata: {code},
  } = useCodeBlockContext();
  const isStartStack = code.includes(START_STACK_SNIPPET);

  return (
    <CopyButton
      {...props}
      className={clsx(
        props.className,
        isStartStack && 'plausible-event-name=Quickstart+Copy',
      )}
    />
  );
}
