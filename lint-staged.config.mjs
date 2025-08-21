/**
 * @filename: lint-staged.config.mjs
 * @type {import('lint-staged').Configuration}
 */
export default {
  "*.{js,jsx,ts,tsx}": ["eslint --fix", "prettier --write"],
  "src/**/*.{ts,tsx}": () => "npx vitest run src/__tests__",
  "*.{json,md,yml,yaml}": ["prettier --write"],
};
