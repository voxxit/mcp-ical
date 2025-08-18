/**
 * @filename: lint-staged.config.js
 * @type {import('lint-staged').Configuration}
 */
export default {
  "*.{js,jsx,ts,tsx}": ["eslint --fix", "prettier --write"],
  "*.{ts,tsx}": ["tsc --noEmit"],
  "!(*.js|*.jsx|*.ts|*.tsx)": ["prettier --write"],
};
