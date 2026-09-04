/*
 * The e2e files are not independent: the restart case takes the SWIRL
 * container down and back up, so it has to run last, and jest's default
 * sequencer orders by file size, which put it first. This pins the order.
 */
const Sequencer = require('@jest/test-sequencer').default;

const ORDER = [
  'gate-zero.test.js',
  'federated.test.js',
  'filters.test.js',
  'missing-index.test.js',
  'permissions.test.js',
  'restart.test.js',
];

const position = test => {
  const at = ORDER.findIndex(name => test.path.endsWith(name));
  return at === -1 ? ORDER.length : at;
};

class E2ESequencer extends Sequencer {
  sort(tests) {
    return [...tests].sort(
      (a, b) => position(a) - position(b) || a.path.localeCompare(b.path),
    );
  }

  shard(tests) {
    return this.sort(tests);
  }
}

module.exports = E2ESequencer;
