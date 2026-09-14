import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import importPlugin from "eslint-plugin-import-x";
import prettierPlugin from "eslint-plugin-prettier";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "artifacts/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.stylisticTypeChecked,
  prettier,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: "./tsconfig.test.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "import-x": importPlugin,
      prettier: prettierPlugin,
      "unused-imports": unusedImports,
    },
    rules: {
      ...importPlugin.flatConfigs.recommended.rules,
      "import-x/no-unresolved": "off",
      "prettier/prettier": "error",
      "no-console": "warn",
      "import-x/order": [
        "warn",
        {
          groups: [["builtin", "external"], "internal", ["parent", "sibling", "index"]],
          alphabetize: { order: "asc", caseInsensitive: false },
          "newlines-between": "always",
          named: true,
        },
      ],
      "arrow-body-style": "error",
      "prefer-template": "error",
      quotes: ["error", "double", { avoidEscape: true }],
      "no-unused-vars": "off",
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
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/consistent-type-imports": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportNamedDeclaration > FunctionDeclaration",
          message: "Export functions with export const name = (...) => ... .",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["./*.js", "../*.js", "./**/*.js", "../**/*.js"],
              message: "Use extensionless relative imports in TypeScript source.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["eslint.config.ts", "scripts/**/*.ts", "test/**/*.ts", "src/cli.ts", "src/nitro-patch-helper.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["eslint.config.ts"],
    rules: {
      "import-x/no-named-as-default-member": "off",
    },
  },
);
