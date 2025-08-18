/**
 * @filename: lint-staged.config.js
 * @type {import('lint-staged').Configuration}
 */
export default {
  "*.{js,jsx,ts,tsx}": ["eslint --fix", "prettier --write"],
  "src/**/*.{ts,tsx}": () => "tsc --noEmit",
  "!(.husky/**|*.js|*.jsx|*.ts|*.tsx)": ["prettier --write"],
};
