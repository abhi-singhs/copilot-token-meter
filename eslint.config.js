"use strict";

// Minimal ESLint flat config for copilot-token-meter.
//
// Targets Node 18+ (CommonJS). We intentionally keep the rule set small and
// pragmatic: anything that catches real bugs or accidental var/eqeq drift is
// on; stylistic preferences are off so reviewers focus on logic, not nits.

const globals = {
  // Node globals we use in the codebase.
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  require: "readonly",
  module: "writable",
  exports: "writable",
  setInterval: "readonly",
  clearInterval: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setImmediate: "readonly",
  clearImmediate: "readonly",
  globalThis: "readonly",
};

module.exports = [
  {
    ignores: ["node_modules/**", "**/*.tmp.*"],
  },
  {
    files: ["**/*.js", "bin/copilot-tokens"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals,
    },
    linterOptions: {
      reportUnusedDisableDirectives: "warn",
    },
    rules: {
      // Correctness — catches real bugs.
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": ["warn", { destructuring: "all" }],
      "no-undef": "error",
      "no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
      "no-implicit-globals": "error",
      "no-throw-literal": "error",
      "no-return-await": "warn",
      "no-self-compare": "error",
      "no-unreachable": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-empty": ["error", { allowEmptyCatch: true }],

      // Style — only enforce where it prevents foot-guns.
      "no-multi-assign": "error",
    },
  },
  {
    // Test files: allow longer functions, unused imports for skipped tests.
    files: ["test/**/*.js"],
    rules: {
      "no-unused-vars": "off",
    },
  },
];
