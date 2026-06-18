import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/generated/**",
      "**/asyncapi/output/**",
      "**/prisma.config.ts",
      // CJS config files use require/module which are unavailable in ESM lint context
      "**/*.cjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: true,
      },
    },
    rules: {
      "no-console": "warn",

      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Standalone scripts live under scripts/ (outside each service's tsconfig
    // `src` rootDir), so type-aware linting cannot resolve them to a project.
    files: ["**/scripts/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: false,
      },
    },
    rules: {
      "no-console": "off",
    },
  },
  {
    // Prisma seed scripts live under prisma/ (outside each service's tsconfig
    // `src` rootDir), so type-aware linting cannot resolve them to a project.
    files: ["**/prisma/seed/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: false,
      },
    },
  },
  {
    // Test files live under tests/ (outside each service's tsconfig `src`
    // rootDir), so type-aware linting cannot resolve them to a project.
    files: ["**/tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: false,
      },
    },
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: [
      "packages/auth-jwt/src/middleware.ts",
      "packages/utils/src/locale-middleware.ts",
    ],
    rules: {
      // Express `Request` augmentation requires `namespace Express`.
      "@typescript-eslint/no-namespace": "off",
    },
  },
];
