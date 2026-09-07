import React, {type ReactNode} from 'react';
import clsx from 'clsx';

import styles from './styles.module.css';

const DISCORD_URL = 'https://codemagic.io/discord/';

type Props = {
  className?: string;
};

function DiscordIcon(): ReactNode {
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 127.14 96.36"
      fill="currentColor"
      aria-hidden="true">
      <path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.06 72.06 0 0 0 45.64 0 105.69 105.69 0 0 0 19.39 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.22-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53 48.84 65.69 42.45 65.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53 91.08 65.69 84.69 65.69Z" />
    </svg>
  );
}

export default function NavbarDiscordLink({className}: Props): ReactNode {
  return (
    <a
      className={clsx(styles.link, className)}
      href={DISCORD_URL}
      aria-label="Codemagic Discord"
      target="_blank"
      rel="noopener noreferrer">
      <DiscordIcon />
    </a>
  );
}
