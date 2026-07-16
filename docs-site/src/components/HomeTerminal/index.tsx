import React, {type ReactNode} from 'react';
import {Highlight, themes} from 'prism-react-renderer';

import styles from './styles.module.css';

type Props = {
  label: string;
  children: string;
  language?: string;
};

function guessLanguage(label: string, code: string): string {
  if (label.includes('manifest') || code.trimStart().startsWith('#')) {
    return 'bash';
  }
  if (
    label.includes('local') ||
    code.includes('git clone') ||
    code.includes('./')
  ) {
    return 'bash';
  }
  return 'typescript';
}

export default function HomeTerminal({
  label,
  children,
  language,
}: Props): ReactNode {
  const code = children.replace(/^\n/, '').replace(/\n$/, '');
  const lang = language ?? guessLanguage(label, code);

  return (
    <div className={styles.terminal}>
      <div className={styles.bar}>
        <span className={styles.label}>{label}</span>
      </div>
      <Highlight theme={themes.vsDark} code={code} language={lang}>
        {({className, style, tokens, getLineProps, getTokenProps}) => (
          <pre
            className={`${styles.body} ${className}`}
            style={{...style, background: 'transparent'}}>
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({line})} className={styles.line}>
                <span className={styles.lineNumber} aria-hidden="true">
                  {i + 1}
                </span>
                <span className={styles.lineContent}>
                  {line.map((token, key) => (
                    <span key={key} {...getTokenProps({token})} />
                  ))}
                </span>
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
}
