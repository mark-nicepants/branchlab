// ESLint exists here for exactly one job: the React Hooks rules, which
// TypeScript cannot check. Everything else is already covered — `tsc --strict`
// (incl. noUnusedLocals/noUnusedParameters) is the correctness gate and
// Prettier owns formatting — so no stylistic or general-purpose rules run.
//
// Parser note: `@typescript-eslint/parser` needs TypeScript's JavaScript API,
// which typescript@7 (the native compiler) no longer ships, so Babel's parser
// reads the syntax instead. Neither rule below is type-aware, so nothing is
// lost. The plugins are listed explicitly rather than via
// `@babel/preset-typescript`: with `babelrc`/`configFile` disabled,
// @babel/eslint-parser skips Babel config resolution and only honours
// `parserOpts.plugins`. `jsx` is enabled for .tsx only — in a .ts file it
// would turn `<T>expr` into a JSX element.

import babelParser from "@babel/eslint-parser";
import reactHooks from "eslint-plugin-react-hooks";

const base = (plugins) => ({
  languageOptions: {
    parser: babelParser,
    ecmaVersion: "latest",
    sourceType: "module",
    parserOptions: {
      requireConfigFile: false,
      babelOptions: {
        babelrc: false,
        configFile: false,
        parserOpts: { plugins },
      },
    },
  },
  plugins: { "react-hooks": reactHooks },
  linterOptions: {
    // Only the two rules below run here, so `eslint-disable` comments for any
    // other rule (e.g. the no-console ones in the dev-only mocks) would
    // otherwise be reported as unused.
    reportUnusedDisableDirectives: "off",
  },
  rules: {
    "react-hooks/rules-of-hooks": "error",
    // Error, not warn: the few places where a narrowed dep list is deliberate
    // carry an explicit eslint-disable comment explaining why.
    "react-hooks/exhaustive-deps": "error",
  },
});

export default [
  { files: ["src/**/*.ts"], ...base(["typescript"]) },
  { files: ["src/**/*.tsx"], ...base(["typescript", "jsx"]) },
];
