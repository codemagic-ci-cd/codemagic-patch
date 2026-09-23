import {
  createElement,
  forwardRef,
  useEffect,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type ComponentType,
  type ForwardRefExoticComponent,
  type JSX,
  type RefAttributes,
} from "react";

import { AppState } from "react-native";

import { sync } from "./sync";
import { CheckFrequency, type SyncOptions, type WrapOptions } from "./types";

// `any` is the only constraint under which `ComponentPropsWithoutRef` and
// `ComponentRef` can read a concrete root's props and instance types back out
// of the generic; `unknown` and `never` both collapse them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRootComponent = ComponentType<any>;

type UnknownProps = Record<string, unknown>;

/**
 * The wrapper's props: the root's props, with the ones a class root defaults
 * through `defaultProps` optional, as they are when rendering the root itself.
 */
export type WrappedRootProps<C extends AnyRootComponent> =
  JSX.LibraryManagedAttributes<C, ComponentPropsWithoutRef<C>>;

/**
 * Component returned by `wrap()`. Accepts the root component's props, forwards
 * `ref` to the root (class roots receive their instance, function roots receive
 * whatever ref they themselves support). Custom static properties are not copied.
 */
export type WrappedRootComponent<C extends AnyRootComponent> =
  ForwardRefExoticComponent<
    WrappedRootProps<C> & RefAttributes<ComponentRef<C>>
  >;

function rootDisplayName(root: AnyRootComponent): string {
  return root.displayName || root.name || "Component";
}

/**
 * Wraps the app's root component so a `sync()` runs once the root has mounted.
 *
 * ```tsx
 * import * as Patch from "@codemagic/react-native-patch";
 *
 * export default Patch.wrap(App);
 * ```
 *
 * The root renders immediately; there is no built-in loading screen and the
 * update check never blocks the first frame. `sync()` is invoked from a mount
 * effect, never during module evaluation or render. ON_APP_RESUME also checks
 * on background/inactive-to-active transitions. Install options pass through
 * to `sync()`, whose defaults apply: ordinary updates install
 * ON_NEXT_RESTART, mandatory updates install IMMEDIATE.
 *
 * Because `sync()` begins by calling `notifyAppReady()`, mounting the wrapped
 * root is what acknowledges the running package as healthy. Apps that must
 * finish an asynchronous bootstrap before they can vouch for the running
 * bundle should call `sync()` or `notifyAppReady()` themselves at that point
 * instead of using `wrap()`.
 *
 * Every mount of the wrapped root starts a `sync()`; `sync()` is safe to call
 * repeatedly and its concurrency guard turns overlapping calls (React Strict
 * Mode's double effect, a nested `wrap()`) into a `sync-in-progress` result
 * rather than a second update cycle.
 */
export function wrap<C extends AnyRootComponent>(
  Root: C,
  options?: WrapOptions,
): WrappedRootComponent<C> {
  const {
    checkFrequency = CheckFrequency.ON_APP_START,
    ...installOptions
  } = options ?? {};
  const syncOptions: SyncOptions | undefined = options
    ? installOptions
    : undefined;
  // The public signature keeps the root's concrete props and ref types; the
  // element factory below only needs to know it is rendering some component.
  const RootComponent = Root as ComponentType<UnknownProps>;

  const Wrapped = forwardRef<unknown, UnknownProps>(
    function PatchWrappedRoot(props, ref) {
      useEffect(() => {
        void sync(syncOptions);
        if (checkFrequency !== CheckFrequency.ON_APP_RESUME) return;

        let previousState = AppState.currentState;
        const subscription = AppState.addEventListener(
          "change",
          (nextState) => {
            const returning =
              previousState === "background" || previousState === "inactive";
            previousState = nextState;
            if (returning && nextState === "active") void sync(syncOptions);
          },
        );
        return () => subscription.remove();
      }, []);

      return createElement(RootComponent, { ...props, ref });
    },
  );

  Wrapped.displayName = `Patch.wrap(${rootDisplayName(Root)})`;

  return Wrapped as unknown as WrappedRootComponent<C>;
}
