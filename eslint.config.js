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
      "**/prisma.config.ts",
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
    files: ["scripts/**/*.ts"],
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
