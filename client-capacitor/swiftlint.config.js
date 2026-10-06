// Extends @ionic/swiftlint-config per its own documented override mechanism
// (node_modules/@ionic/swiftlint-config/README.md) rather than forking it.
//
// ios/Tests is excluded entirely: XCTest's own setUp()/tearDown() lifecycle (a stored
// property assigned in setUp, torn down in tearDown, never at declaration) is the
// canonical Apple-idiomatic pattern for per-test fixtures, and it requires an
// implicitly-unwrapped optional (`var tempDir: URL!`) — Swift has no other way to
// declare "assigned before every test, absent only outside the test lifecycle" for a
// stored property. That is not sloppy code; it is the same pattern Xcode's own File >
// New > Unit Test Case template generates. Production code under ios/Sources/ still
// gets the full, stricter rule set unchanged.
module.exports = {
  ...require('@ionic/swiftlint-config'),
  excluded: [...require('@ionic/swiftlint-config').excluded, '${PWD}/ios/Tests'],
};
