// @ts-check
/// <reference types="node" />
import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
    { ignores: ["dist/", "coverage/"] },
    eslint.configs.recommended,
    // Type-aware rules catch async mistakes such as un-awaited promises.
    ...tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            globals: globals.node,
            parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
        },
        rules: {
            "@typescript-eslint/consistent-type-imports": "error",
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
        },
    },
    { files: ["**/*.js"], ...tseslint.configs.disableTypeChecked },
);
