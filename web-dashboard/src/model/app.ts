// Wire-shape DTOs derived from server/src/domain/types.ts @ 25b9477
// Server `Date` fields serialize to ISO strings on the wire.

export interface App {
  id: string;
  teamId: string;
  name: string;
  requireCodeSigning: boolean;
  /**
   * Which framework the app is built with — `react-native` / `capacitor` on
   * stock servers, but any value the server accepts (model/framework.ts).
   */
  framework: string;
  createdAt: string;
  updatedAt: string;
}
