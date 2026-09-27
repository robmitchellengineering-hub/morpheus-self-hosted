import globals from "globals";
import pluginJs from "@eslint/js";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginUnusedImports from "eslint-plugin-unused-imports";

export default [
  {
    files: [
      "src/components/**/*.{js,mjs,cjs,jsx}",
      "src/pages/**/*.{js,mjs,cjs,jsx}",
      // src/hooks was missing from this list, so the react-hooks plugin was
      // never registered for those files. That made
      // `// eslint-disable-line react-hooks/exhaustive-deps` in useRunTimer.js
      // reference a rule that did not exist in scope — reported as
      // "Definition for rule ... was not found".
      "src/hooks/**/*.{js,mjs,cjs,jsx}",
      // Siblings of the same gap: these directories matched no config block
      // either, so nothing inside them was linted at all.
      "src/contexts/**/*.{js,mjs,cjs,jsx}",
      "src/api/**/*.{js,mjs,cjs,jsx}",
      "src/utils/**/*.{js,mjs,cjs,jsx}",
      "src/Layout.jsx",
    ],
    ignores: ["src/lib/**/*", "src/components/ui/**/*"],
    ...pluginJs.configs.recommended,
    ...pluginReact.configs.flat.recommended,
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    plugins: {
      react: pluginReact,
      "react-hooks": pluginReactHooks,
      "unused-imports": pluginUnusedImports,
    },
    rules: {
      "no-unused-vars": "off",
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
      "react/prop-types": "off",
      "react/react-in-jsx-scope": "off",
      "react/no-unknown-property": [
        "error",
        { ignore: ["cmdk-input-wrapper", "toast-close"] },
      ],
      "react-hooks/rules-of-hooks": "error",
      // Enabled so the 15 existing `react-hooks/exhaustive-deps` disable
      // directives in src/ actually suppress something. While the rule was
      // undefined, ESLint treated every one of them as an unused directive —
      // and `eslint --fix` silently DELETED them, erasing the record of 15
      // deliberately-chosen dependency arrays. Warnings only, so --quiet
      // (what `npm run lint` uses) still passes.
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // server/** was matched by NO config block, so nothing under it was ever
    // linted. CI's only server-wide checks were `node --check` (syntax, which
    // never resolves a name) and an import-path/export resolver — so a variable
    // read outside the block that declares it was invisible to every gate.
    // That is how #356 shipped `ReferenceError: chunkOps is not defined` (every
    // code build died; hotfixed in #361) and how three more of the same mistake
    // in the same file survived that hotfix (#362).
    files: ["server/src/**/*.js"],
    ...pluginJs.configs.recommended,
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "unused-imports": pluginUnusedImports,
    },
    rules: {
      ...pluginJs.configs.recommended.rules,
      // Same split as the frontend block: unused imports are an error, unused
      // locals are a warning (hidden by `--quiet`). 34 unused locals exist
      // today; they are noise, not correctness, and clearing them is its own change.
      "no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        { vars: "all", varsIgnorePattern: "^_", args: "after-used", argsIgnorePattern: "^_" },
      ],
    },
  },
];
