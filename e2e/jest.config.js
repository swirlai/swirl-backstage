/*
 * The e2e suite is deliberately separate from `yarn test`. It is plain
 * CommonJS with no transform, so it needs no babel or ts-jest configuration,
 * and it runs one file at a time: the restart case takes the SWIRL container
 * down and back up, and nothing else may be querying while it does.
 *
 * Do not run this directly. `yarn e2e` brings the stack up first.
 */
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  transform: {},
  maxWorkers: 1,
  testSequencer: '<rootDir>/testSequencer.js',
  testTimeout: 60000,
  verbose: true,
};
