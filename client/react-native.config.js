module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: "./android",
        packageImportPath: "import io.codemagic.patch.CodemagicPatchPackage;",
        packageInstance: "new CodemagicPatchPackage()",
      },
      ios: {},
    },
  },
};
