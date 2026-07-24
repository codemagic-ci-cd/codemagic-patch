import React, {type ReactNode} from 'react';
import {useColorMode} from '@docusaurus/theme-common';
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

/** Shell-style gutter: `$` for commands, `›` for code, blank for empty/comment lines. */
function promptForLine(
  language: string,
  lineText: string,
  lineIndex: number,
  firstCodeLine: number,
): string {
  const trimmed = lineText.trim();
  if (trimmed === '') {
    return '';
  }
  if (language === 'bash') {
    if (trimmed.startsWith('#')) {
      return '';
    }
    return '$';
  }
  return lineIndex === firstCodeLine ? '›' : '';
}

export default function HomeTerminal({
  label,
  children,
  language,
}: Props): ReactNode {
  const {colorMode} = useColorMode();
  const code = children.replace(/^\n/, '').replace(/\n$/, '');
  const lang = language ?? guessLanguage(label, code);
  const prismTheme =
    colorMode === 'dark' ? themes.vsDark : themes.github;
  const lines = code.split('\n');
  const firstCodeLine = lines.findIndex((line) => line.trim() !== '');

  return (
    <div className={styles.terminal}>
      <div className={styles.bar}>
        <span className={styles.label}>{label}</span>
      </div>
      <Highlight theme={prismTheme} code={code} language={lang}>
        {({className, style, tokens, getLineProps, getTokenProps}) => (
          <pre
            className={`${styles.body} ${className}`}
            style={{...style, background: 'transparent'}}>
            {tokens.map((line, i) => {
              const lineText = lines[i] ?? '';
              const prompt = promptForLine(lang, lineText, i, firstCodeLine);
              return (
                <div key={i} {...getLineProps({line})} className={styles.line}>
                  <span
                    className={
                      prompt
                        ? styles.prompt
                        : `${styles.prompt} ${styles.promptEmpty}`
                    }
                    aria-hidden="true">
                    {prompt}
                  </span>
                  <span className={styles.lineContent}>
                    {line.map((token, key) => (
                      <span key={key} {...getTokenProps({token})} />
                    ))}
                  </span>
                </div>
              );
            })}
          </pre>
        )}
      </Highlight>
    </div>
  );
}
