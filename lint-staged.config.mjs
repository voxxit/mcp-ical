/**
 * @filename: lint-staged.config.mjs
 * @type {import('lint-staged').Configuration}
 */
export default {
  "*.{js,jsx,ts,tsx}": ["eslint --fix", "prettier --write"],
  "src/**/*.{ts,tsx}": () => "npx vitest run src/__tests__",
  "src/worker-auth.ts": () => "npx tsc --project tsconfig.worker.json --noEmit",
  "src/clerk-auth.ts": () => "npx tsc --project tsconfig.worker.json --noEmit",
  "*.{json,md,yml,yaml}": ["prettier --write"],
};
