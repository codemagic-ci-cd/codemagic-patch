declare module "plist" {
  export function parse(xml: string): unknown;
}

declare module "xcode" {
  export interface ParsedXcodeProject {
    getBuildProperty(
      propertyName: string,
      buildConfigurationName?: string,
      targetName?: string,
    ): unknown;
  }

  export interface XcodeProject {
    parseSync(): ParsedXcodeProject;
  }

  const xcode: {
    project(filePath: string): XcodeProject;
  };

  export = xcode;
}
