/**
 * @filename: lint-staged.config.mjs
 * @type {import('lint-staged').Configuration}
 */
export default {
  "*.{js,jsx,ts,tsx}": ["eslint --fix", "prettier --write"],
  "src/**/*.{ts,tsx}": () => ["tsc --noEmit", "npm test"],
  "!(.husky/**|*.js|*.jsx|*.ts|*.tsx)": ["prettier --write"],
};
