export default {
  '*.{ts,js,mjs,cjs}': [
    'bun node_modules/eslint/bin/eslint.js --fix --max-warnings=0',
    'bun node_modules/prettier/bin/prettier.cjs --write',
  ],
  '*.{json,md,yml,yaml}': ['bun node_modules/prettier/bin/prettier.cjs --write'],
};
