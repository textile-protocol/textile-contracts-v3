// Coverage config for the public swap-contracts repo. The monorepo version of
// this file pins testfiles that only exist there, so it gets overridden here.
module.exports = {
  skipFiles: ['mocks/', 'v3/mocks/'],
  configureYulOptimizer: true,
}
