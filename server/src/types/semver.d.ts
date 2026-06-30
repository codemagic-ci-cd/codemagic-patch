declare module "semver" {
  export function compare(left: string, right: string): number;
  export function rcompare(left: string, right: string): number;
  export function valid(version: string): string | null;
}
