import React, {type ComponentProps, type ReactNode} from 'react';
import {useThemeConfig} from '@docusaurus/theme-common';
import {useNavbarSecondaryMenu} from '@docusaurus/theme-common/internal';
import Translate from '@docusaurus/Translate';
import SidebarSearch from '@site/src/components/SidebarSearch';
import SidebarMaintainedBy from '@site/src/components/SidebarMaintainedBy';

import styles from './styles.module.css';

function SecondaryMenuBackButton(props: ComponentProps<'button'>) {
  return (
    <button {...props} type="button" className="clean-btn navbar-sidebar__back">
      <Translate
        id="theme.navbar.mobileSidebarSecondaryMenu.backButtonLabel"
        description="The label of the back button to return to main menu, inside the mobile navbar sidebar secondary menu (notably used to display the docs sidebar)">
        ← Back to main menu
      </Translate>
    </button>
  );
}

export default function NavbarMobileSidebarSecondaryMenu(): ReactNode {
  const isPrimaryMenuEmpty = useThemeConfig().navbar.items.length === 0;
  const secondaryMenu = useNavbarSecondaryMenu();

  return (
    <div className={styles.panel}>
      {!isPrimaryMenuEmpty && (
        <SecondaryMenuBackButton onClick={() => secondaryMenu.hide()} />
      )}
      <SidebarSearch className={styles.search} />
      <div className={styles.menu}>{secondaryMenu.content}</div>
      <SidebarMaintainedBy className={styles.maintainedBy} />
    </div>
  );
}
