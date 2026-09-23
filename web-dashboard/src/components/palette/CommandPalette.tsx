// ⌘K / Ctrl+K command palette: one overlay that jumps anywhere in the
// dashboard, so navigation never requires the mouse. `./commands` owns the data
// model and the ranking; this file owns the hotkey, the dialog and the catalog.
//
// Every row is a navigation. The Actions rows land on a page with its dialog
// already open (`?new=1`), which is why this component needs no toast, no
// clipboard and no app-shell state of its own.
//
// The hotkey listener is CAPTURE phase so the browser's own Ctrl/⌘+K
// (address-bar search) is preempted, and it stands down whenever another
// `aria-modal` dialog is mounted: Modal and MobileNavDrawer recapture focus at
// the document level while they are up, so a palette stacked over one would
// lose its input.
//
// The dialog repeats Modal's overlay contract rather than reusing Modal, which
// is built around a titled header: focus moves in on open and RESTORES to the
// opener on close, body scroll is locked, Esc and backdrop click close, and a
// document-level focusin listener pulls stray focus back into the input.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueries } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

import { useApps } from "../../api/hooks/apps";
import { deploymentsQueryOptions } from "../../api/hooks/deployments";
import { useServerStatusAvailability } from "../../api/hooks/serverStatus";
import { useTeams } from "../../api/hooks/teams";
import { logoutSession } from "../../auth/webConfig";
import { initialsFor } from "../../lib/appTile";
import type { App } from "../../model/app";
import type { Deployment } from "../../model/deployment";
import type { Team } from "../../model/team";
import {
  metricsAppPath,
  metricsDeploymentPath,
  metricsIndexPath,
} from "../../pages/metrics/metricsPaths";
import { useTeamRole } from "../../rbac/useTeamRole";
import { KBD } from "../ui/kbd";
import { MENU_LABEL } from "../ui/menu";
import { flattenSections, isPaletteShortcut, sectionsFor } from "./commands";
import type { Command } from "./commands";

/** One app with its deployments — what the four data-driven sections render. */
export interface AppTarget {
  app: App;
  /** Empty until `GET /v1/apps/:appId/deployments` answers for that app. */
  deployments: readonly Deployment[];
}

const NO_APPS: readonly App[] = [];
const NO_TEAMS: readonly Team[] = [];
const NO_APP_TARGETS: readonly AppTarget[] = [];
const NO_DEPLOYMENTS: readonly Deployment[] = [];

/**
 * Deployment lists cost one request per app. Apps past this many still get
 * their own row in Apps and Metrics - Rolled up; only their per-deployment rows
 * are skipped, and typing still reaches every app.
 */
const DEPLOYMENT_FANOUT_LIMIT = 25;

/** Reopening the palette should not re-request lists it just read. */
const DEPLOYMENTS_STALE_TIME_MS = 60_000;

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Route param or last-team fallback; null hides the team-scoped sections. */
  teamId: string | null;
}

function hasBlockingDialog(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

export function CommandPalette({
  open,
  onOpenChange,
  teamId,
}: CommandPaletteProps) {
  // Mirrored so the hotkey below subscribes exactly once.
  const openRef = useRef(open);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    openRef.current = open;
    onOpenChangeRef.current = onOpenChange;
  }, [open, onOpenChange]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event)) {
        return;
      }
      event.preventDefault();
      if (openRef.current) {
        onOpenChangeRef.current(false);
        return;
      }
      if (hasBlockingDialog()) {
        return;
      }
      onOpenChangeRef.current(true);
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);

  const close = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  if (!open) {
    return null;
  }

  return teamId === null ? (
    <AccountPalette onClose={close} />
  ) : (
    <TeamPalette teamId={teamId} onClose={close} />
  );
}

// --- Catalog ---------------------------------------------------------------

interface CommandContext {
  go: (to: string) => void;
}

function useCommandContext(): CommandContext {
  const navigate = useNavigate();
  return useMemo(
    () => ({
      go: (to: string) => {
        void navigate(to);
      },
    }),
    [navigate],
  );
}

interface CatalogOptions {
  /** Null on team-less routes (/account/*) before any team is remembered. */
  teamId: string | null;
  canCreateApp: boolean;
  canManageIam: boolean;
  /** False until `GET /v1/server/status` answers anything but 501. */
  statusAvailable: boolean;
  appTargets: readonly AppTarget[];
  /** Teams other than the active one; empty on a single-team install. */
  otherTeams: readonly Team[];
}

/**
 * The catalog in default-view order; ranking reorders it once a query is typed.
 * RBAC-denied commands are OMITTED rather than disabled, because a palette row
 * has nowhere to carry the "Requires admin" tooltip the pages use — the sidebar
 * hides Members on the same reasoning. The server stays the authority.
 */
function buildCommands(
  context: CommandContext,
  options: CatalogOptions,
): readonly Command[] {
  const { teamId } = options;
  const commands: Command[] = [];

  if (teamId !== null && options.canCreateApp) {
    commands.push({
      id: "action-create-app",
      label: "Create app",
      group: "Actions",
      subtitle: "New OTA target with Staging and Production",
      keywords: ["new", "add", "application", "target", "register"],
      icon: (
        <Glyph>
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </Glyph>
      ),
      // `?new=1` is what makes this work from any route: the page owns the
      // dialog and opens it off the search param (see AppsPage).
      run: () => {
        context.go(`/teams/${teamId}/apps?new=1`);
      },
    });
  }

  commands.push({
    id: "action-create-token",
    label: "Create token",
    group: "Actions",
    subtitle: "Personal access token for the CLI and CI",
    keywords: ["api", "token", "pat", "cli", "new", "access", "key", "secret"],
    icon: (
      <Glyph>
        <circle cx="7.5" cy="15.5" r="4.5" />
        <path d="m10.5 12.5 8-8 3 3-3 3-2-2" />
      </Glyph>
    ),
    // Tokens are per user, so no team or role gate.
    run: () => {
      context.go("/account/tokens?new=1");
    },
  });

  if (teamId !== null && options.canManageIam) {
    commands.push({
      id: "action-add-member",
      label: "Add member",
      group: "Actions",
      subtitle: "Invite or provision someone on this team",
      keywords: [
        "invite",
        "user",
        "users",
        "people",
        "teammate",
        "role",
        "access",
        "provision",
        "new",
      ],
      icon: (
        <Glyph>
          <path d="M14 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="8" cy="7" r="4" />
          <path d="M19 8v6M22 11h-6" />
        </Glyph>
      ),
      run: () => {
        context.go(`/teams/${teamId}/members?new=1`);
      },
    });
  }

  if (teamId !== null) {
    commands.push(
      {
        id: "nav-apps",
        label: "Apps",
        group: "Navigate",
        subtitle: "All OTA targets in this team",
        keywords: ["view", "applications", "list", "targets", "browse"],
        icon: (
          <Glyph>
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
          </Glyph>
        ),
        run: () => {
          context.go(`/teams/${teamId}/apps`);
        },
      },
      {
        id: "nav-metrics",
        label: "Metrics",
        group: "Navigate",
        subtitle: "Adoption, installs and failures",
        keywords: [
          "analytics",
          "stats",
          "adoption",
          "charts",
          "usage",
          "installs",
        ],
        icon: (
          <Glyph>
            <path d="M3 3v18h18" />
            <path d="M8 17v-5M12.5 17V8M17 17v-3" />
          </Glyph>
        ),
        run: () => {
          context.go(metricsIndexPath(teamId));
        },
      },
      {
        id: "nav-team-overview",
        label: "Overview",
        group: "Navigate",
        subtitle: "Summary for the active team",
        keywords: ["team", "home", "dashboard", "start", "summary"],
        icon: (
          <Glyph>
            <path d="M3 11 12 4l9 7" />
            <path d="M5 10v10h14V10" />
          </Glyph>
        ),
        run: () => {
          context.go(`/teams/${teamId}`);
        },
      },
    );

    if (options.canManageIam) {
      commands.push({
        id: "nav-members",
        label: "Members",
        group: "Navigate",
        subtitle: "Users, roles and invitations",
        keywords: [
          "users",
          "people",
          "team",
          "invite",
          "roles",
          "permissions",
          "access",
        ],
        icon: (
          <Glyph>
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
          </Glyph>
        ),
        run: () => {
          context.go(`/teams/${teamId}/members`);
        },
      });
    }

    // Apps stays flat and the per-deployment rows live in their own sections:
    // nested under each app, one app with several deployments pushed the next
    // app's row off the default view. Collected in one pass and appended in
    // section order, since insertion order is the order WITHIN a section.
    const releaseCommands: Command[] = [];
    const deploymentMetricsCommands: Command[] = [];

    for (const { app, deployments } of options.appTargets) {
      commands.push({
        id: `app-${app.id}`,
        label: app.name,
        group: "Apps",
        subtitle: "Deployments, releases and settings",
        keywords: ["app", "deployment", "release", "rollout", app.id],
        icon: <AppTile app={app} />,
        run: () => {
          context.go(`/teams/${teamId}/apps/${app.id}`);
        },
      });

      commands.push({
        id: `metrics-app-${app.id}`,
        label: `${app.name} metrics`,
        group: "Metrics - Rolled up",
        subtitle: "Rollup across every deployment",
        keywords: [
          "metrics",
          "rollup",
          "analytics",
          "adoption",
          "installs",
          "failures",
          "success rate",
          app.id,
        ],
        icon: <AppTile app={app} />,
        run: () => {
          context.go(metricsAppPath(teamId, app.id));
        },
      });

      for (const deployment of deployments) {
        // Release history lives on the deployment detail screen, next to
        // rollout, promote and rollback.
        releaseCommands.push({
          id: `releases-${deployment.id}`,
          label: `${app.name} · ${deployment.name}`,
          group: "Releases",
          subtitle: "Release history and rollouts",
          cluster: app.id,
          keywords: [
            "release",
            "releases",
            "history",
            "rollout",
            "promote",
            "rollback",
            "patch",
            "deployment",
            app.name,
            deployment.id,
          ],
          icon: (
            <Glyph>
              <path d="M3 6h18M3 12h18M3 18h18" />
            </Glyph>
          ),
          run: () => {
            context.go(
              `/teams/${teamId}/apps/${app.id}/deployments/${deployment.id}`,
            );
          },
        });

        // Shares its label with the Releases row above; the section heading and
        // the subtitle are what tell the two destinations apart.
        deploymentMetricsCommands.push({
          id: `metrics-deployment-${deployment.id}`,
          label: `${app.name} · ${deployment.name}`,
          group: "Metrics - Per Deployment",
          subtitle: "Versions, adoption and update outcomes",
          cluster: app.id,
          keywords: [
            "metrics",
            "analytics",
            "adoption",
            "installs",
            "failures",
            "deployment",
            app.name,
            deployment.id,
          ],
          icon: (
            <Glyph>
              <path d="M3 3v18h18" />
              <path d="M8 17v-5M12.5 17V8M17 17v-3" />
            </Glyph>
          ),
          run: () => {
            context.go(metricsDeploymentPath(teamId, app.id, deployment.id));
          },
        });
      }
    }

    commands.push(...releaseCommands, ...deploymentMetricsCommands);

    for (const team of options.otherTeams) {
      commands.push({
        id: `team-${team.id}`,
        label: `Switch to ${team.name}`,
        group: "Teams",
        keywords: ["team", "change", "workspace", team.id],
        icon: (
          <Glyph>
            <path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3" />
            <path d="m16 17 5-5-5-5" />
            <path d="M21 12H9" />
          </Glyph>
        ),
        run: () => {
          context.go(`/teams/${team.id}/apps`);
        },
      });
    }
  }

  commands.push(
    {
      id: "nav-profile",
      label: "Profile",
      group: "Account",
      subtitle: "Your account details",
      keywords: ["me", "identity", "whoami", "email", "user"],
      icon: (
        <Glyph>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21v-1a6 6 0 0 1 12 0v1" />
        </Glyph>
      ),
      run: () => {
        context.go("/account/profile");
      },
    },
    {
      id: "nav-tokens",
      label: "API tokens",
      group: "Account",
      subtitle: "Personal access tokens for the CLI",
      keywords: ["pat", "token", "cli", "auth", "key", "secret"],
      icon: (
        <Glyph>
          <circle cx="7.5" cy="15.5" r="4.5" />
          <path d="m10.5 12.5 8-8 3 3-3 3-2-2" />
        </Glyph>
      ),
      run: () => {
        context.go("/account/tokens");
      },
    },
  );

  if (options.statusAvailable) {
    commands.push({
      id: "nav-status",
      label: "Server status",
      group: "Account",
      subtitle: "Instance health and version",
      keywords: [
        "health",
        "uptime",
        "instance",
        "version",
        "storage",
        "database",
      ],
      icon: (
        <Glyph>
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <path d="M6 21h12M12 17v4" />
        </Glyph>
      ),
      run: () => {
        context.go("/account/server");
      },
    });
  }

  commands.push({
    id: "action-sign-out",
    label: "Sign out",
    group: "Account",
    subtitle: "Revoke this session and return to login",
    keywords: ["log out", "logout", "leave", "exit", "quit"],
    icon: (
      <Glyph>
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <path d="m16 17 5-5-5-5" />
        <path d="M21 12H9" />
      </Glyph>
    ),
    // Best-effort revoke, as on the Profile page: land on /login either way.
    run: () => {
      void (async () => {
        try {
          await logoutSession();
        } finally {
          context.go("/login");
        }
      })();
    },
  });

  return commands;
}

// --- Data branches ---------------------------------------------------------
// Split so the team hooks stay unconditional and `useApps` is never called with
// a team-less id; both branches render the same frame.

interface BranchProps {
  onClose: () => void;
}

function AccountPalette({ onClose }: BranchProps) {
  const context = useCommandContext();
  const statusAvailable = useServerStatusAvailability() === "available";
  const commands = useMemo(
    () =>
      buildCommands(context, {
        teamId: null,
        canCreateApp: false,
        canManageIam: false,
        statusAvailable,
        appTargets: NO_APP_TARGETS,
        otherTeams: NO_TEAMS,
      }),
    [context, statusAvailable],
  );
  return <PaletteFrame commands={commands} onClose={onClose} />;
}

function TeamPalette({ teamId, onClose }: BranchProps & { teamId: string }) {
  const context = useCommandContext();
  const statusAvailable = useServerStatusAvailability() === "available";
  const appsQuery = useApps(teamId);
  const teamsQuery = useTeams();
  const { can, isLoading: roleLoading } = useTeamRole(teamId);

  const apps = appsQuery.data ?? NO_APPS;
  const fanOutApps = useMemo(
    () => apps.slice(0, DEPLOYMENT_FANOUT_LIMIT),
    [apps],
  );
  // `combine` keeps the derived array referentially stable — it re-runs only
  // when a query result changes — so typing does not rebuild the catalog. It
  // closes over nothing, so an app rename is picked up by the memo below.
  const deploymentLists = useQueries({
    queries: fanOutApps.map((app) => ({
      ...deploymentsQueryOptions(app.id),
      staleTime: DEPLOYMENTS_STALE_TIME_MS,
    })),
    combine: (results) =>
      results.map((result) => result.data ?? NO_DEPLOYMENTS),
  });
  const appTargets = useMemo(
    () =>
      apps.map((app, index) => ({
        app,
        deployments: deploymentLists[index] ?? NO_DEPLOYMENTS,
      })),
    [apps, deploymentLists],
  );

  const otherTeams = useMemo(
    () =>
      teamsQuery.data === undefined
        ? NO_TEAMS
        : teamsQuery.data.filter((team) => team.id !== teamId),
    [teamsQuery.data, teamId],
  );
  // While the role resolves, gated rows stay out rather than flashing in.
  const canCreateApp = !roleLoading && can("app.create");
  const canManageIam = !roleLoading && can("iam.manage");

  const commands = useMemo(
    () =>
      buildCommands(context, {
        teamId,
        canCreateApp,
        canManageIam,
        statusAvailable,
        appTargets,
        otherTeams,
      }),
    [
      context,
      teamId,
      canCreateApp,
      canManageIam,
      statusAvailable,
      appTargets,
      otherTeams,
    ],
  );

  return (
    <PaletteFrame
      commands={commands}
      onClose={onClose}
      appsPending={appsQuery.isPending}
    />
  );
}

// --- Dialog ----------------------------------------------------------------

const OVERLAY =
  "fixed inset-0 z-[110] flex animate-fade items-start justify-center overflow-auto bg-overlay-soft p-4 pt-[12vh] max-shell:pt-[8vh]";

const PANEL =
  "flex w-full max-w-[620px] animate-rise flex-col overflow-hidden rounded-xl bg-surface shadow-lg";

const OPTION =
  "flex w-full items-center gap-[11px] rounded-sm border-0 px-[11px] py-2.5 text-left text-[15px] font-medium [transition:.12s]";

// Idle and active swap wholesale (both set background and color) per the
// no-merge contract in Button.tsx.
const OPTION_IDLE = "bg-transparent text-fg";
const OPTION_ACTIVE = "bg-blue-tint text-fg";

/** Fixed slot so glyph rows and identicon rows align on one text column. */
const ICON_SLOT = "grid size-[22px] flex-none place-items-center";

function Glyph({ children }: { children: ReactNode }) {
  return (
    <span className={`${ICON_SLOT} text-fg-3 [&_svg]:size-[17px]`}>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {children}
      </svg>
    </span>
  );
}

/** The `.app-ico` identicon at palette-row scale (see ui/cell.ts). */
function AppTile({ app }: { app: App }) {
  return (
    <span
      className={`${ICON_SLOT} rounded-xs bg-blue text-[10.5px] font-bold text-white`}
      aria-hidden="true"
    >
      {initialsFor(app.name)}
    </span>
  );
}

interface PaletteFrameProps {
  commands: readonly Command[];
  onClose: () => void;
  /** Apps still loading — the empty state says so instead of "no matches". */
  appsPending?: boolean;
}

function PaletteFrame({
  commands,
  onClose,
  appsPending = false,
}: PaletteFrameProps) {
  const [query, setQuery] = useState("");
  // The highlight is stored WITH the query it belongs to, so a re-ranked list
  // resets to its best match by derivation instead of an effect.
  const [highlight, setHighlight] = useState({ query: "", index: 0 });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const mouseDownOnOverlayRef = useRef(false);
  const listboxId = useId();

  const sections = useMemo(
    () => sectionsFor(commands, query),
    [commands, query],
  );
  const items = useMemo(() => flattenSections(sections), [sections]);
  const rendered = useMemo(
    () =>
      sections.map((section, sectionIndex) => {
        const offset = sections
          .slice(0, sectionIndex)
          .reduce((total, previous) => total + previous.commands.length, 0);
        return {
          group: section.group,
          rows: section.commands.map((command, rowIndex) => ({
            command,
            index: offset + rowIndex,
          })),
        };
      }),
    [sections],
  );

  const activeIndex = highlight.query === query ? highlight.index : 0;
  const activeSafe =
    items.length === 0 ? -1 : Math.min(activeIndex, items.length - 1);
  const activeCommand = activeSafe === -1 ? undefined : items[activeSafe];
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  useEffect(() => {
    const panel = panelRef.current;
    const input = inputRef.current;
    if (panel === null || input === null) {
      return;
    }
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    input.focus();

    const handleFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !panel.contains(event.target)) {
        input.focus();
      }
    };
    document.addEventListener("focusin", handleFocusIn);

    return () => {
      document.removeEventListener("focusin", handleFocusIn);
      document.body.style.overflow = previousBodyOverflow;
      if (opener !== null && opener.isConnected) {
        opener.focus();
      }
    };
  }, []);

  useEffect(() => {
    if (activeSafe < 0) {
      return;
    }
    listRef.current
      ?.querySelector<HTMLElement>(`[data-command-index="${activeSafe}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeSafe]);

  const activate = useCallback(
    (command: Command) => {
      // Close first: the command navigates, and the unmount's focus restore
      // should land before the destination mounts anything of its own.
      onClose();
      command.run();
    },
    [onClose],
  );

  const setActive = useCallback(
    (index: number) => {
      setHighlight({ query, index });
    },
    [query],
  );

  const move = useCallback(
    (delta: number) => {
      if (items.length === 0) {
        return;
      }
      const base = activeSafe < 0 ? 0 : activeSafe;
      setHighlight({
        query,
        index: (base + delta + items.length) % items.length,
      });
    },
    [items.length, activeSafe, query],
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // While an IME is composing (Japanese/Chinese/Korean candidate selection)
    // the arrows walk the candidate list and Enter confirms a candidate, so
    // those keystrokes belong to the input method, not to the palette —
    // otherwise confirming a candidate would run the highlighted command.
    // `keyCode === 229` is the Safari fallback: it ends composition before the
    // keydown, leaving `isComposing` already false on the confirming Enter.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return;
    }

    switch (event.key) {
      case "Escape":
        event.preventDefault();
        onClose();
        return;
      case "ArrowDown":
        event.preventDefault();
        move(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        return;
      // Tab moves the highlight rather than escaping the dialog (focus trap).
      case "Tab":
        event.preventDefault();
        move(event.shiftKey ? -1 : 1);
        return;
      case "Enter":
        event.preventDefault();
        if (activeCommand !== undefined) {
          activate(activeCommand);
        }
        return;
      default:
        return;
    }
  };

  return createPortal(
    <div
      className={OVERLAY}
      onMouseDown={(event) => {
        mouseDownOnOverlayRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        // Only a press that also STARTED on the backdrop closes, so a text
        // selection dragged out of the panel does not dismiss it.
        const pressStartedHere = mouseDownOnOverlayRef.current;
        mouseDownOnOverlayRef.current = false;
        if (pressStartedHere && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        className={PANEL}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-3 border-b border-border px-[18px] py-3.5">
          <span
            className="flex-none text-fg-3 [&_svg]:size-[18px]"
            aria-hidden="true"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="16.5" y1="16.5" x2="21" y2="21" />
            </svg>
          </span>
          <input
            ref={inputRef}
            type="text"
            className="w-full border-0 bg-transparent p-0 text-[16px] text-fg [font-family:inherit] placeholder:text-fg-faint focus:outline-none"
            placeholder="Type a command or search"
            aria-label="Type a command or search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            role="combobox"
            aria-expanded
            aria-controls={listboxId}
            aria-activedescendant={
              activeSafe >= 0 ? optionId(activeSafe) : undefined
            }
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Commands"
          className="max-h-[min(52vh,420px)] overflow-auto p-1.5"
        >
          {items.length === 0 ? (
            <div className="px-[11px] py-7 text-center">
              <p className="text-[14px] font-semibold text-fg">
                No matching commands
              </p>
              <p className="mt-1 text-[13px] text-fg-3">
                {appsPending
                  ? "Still loading this team's apps — try again in a moment."
                  : "Try an app name, or a page like Metrics or Members."}
              </p>
            </div>
          ) : (
            rendered.map((section) => (
              <div key={section.group} role="group" aria-label={section.group}>
                <div className={MENU_LABEL}>{section.group}</div>
                {section.rows.map(({ command, index }) => (
                  <button
                    key={command.id}
                    id={optionId(index)}
                    data-command-index={index}
                    type="button"
                    role="option"
                    aria-selected={index === activeSafe}
                    tabIndex={-1}
                    className={`${OPTION} ${
                      index === activeSafe ? OPTION_ACTIVE : OPTION_IDLE
                    }`}
                    // Pointer and keyboard share one highlight, so a click
                    // never fires a different row than the one lit up.
                    onMouseMove={() => {
                      setActive(index);
                    }}
                    onClick={() => {
                      activate(command);
                    }}
                  >
                    {command.icon}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{command.label}</span>
                      {command.subtitle !== undefined ? (
                        <span className="mt-0.5 block truncate text-[12.5px] font-normal text-fg-3">
                          {command.subtitle}
                        </span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-border bg-surface-2 px-[14px] py-2.5 text-[12px] text-fg-3">
          <span className="flex items-center gap-1.5">
            <kbd className={KBD}>↑</kbd>
            <kbd className={KBD}>↓</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className={KBD}>↵</kbd>
            select
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <kbd className={KBD}>esc</kbd>
            close
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
