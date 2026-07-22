# Changelog

All notable changes to this project are documented here.
This file is generated from [Conventional Commits](https://www.conventionalcommits.org)
by [git-cliff](https://git-cliff.org); do not edit it by hand.

## [2.0.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v2.0.0) - 2026-07-22

### Bug Fixes

- Revert typescript to ^6.0.3 to fix CI lockfile mismatch ([79d3a00](https://github.com/ChristopherVR/emf-converter/commit/79d3a00d6020a3404afdd14cf2b9437711ca6aa8))
- Correct ExtTextOutW vertical text alignment ([3763c02](https://github.com/ChristopherVR/emf-converter/commit/3763c024498c73ce3ceadf4cccb1756273d7436f))
- Render source-less PATCOPY BitBlt records as brush fills ([6ca8b8b](https://github.com/ChristopherVR/emf-converter/commit/6ca8b8b4bfbe3adb6f3eeea7f2b210c25152565f))

### Refactor

- Drop legacy positional params from convert API ([a1a371f](https://github.com/ChristopherVR/emf-converter/commit/a1a371ff2175d09ee4fa63abf61f751090ccfe45))

### Build & CI

- Derive release version from commits so every push to main ships ([12c30af](https://github.com/ChristopherVR/emf-converter/commit/12c30af94182f7146bb1a3cb7d619339c6951ee6))

### Chores

- **deps-dev:** Bump typescript from 6.0.3 to 7.0.2 ([42544b4](https://github.com/ChristopherVR/emf-converter/commit/42544b41aee135f6b9a933620367e05150704406))
- **deps:** Bump actions/setup-node in the github-actions group ([6774084](https://github.com/ChristopherVR/emf-converter/commit/677408466be1d8b3680493f882b4ec65a8a2b4cf))

## [1.6.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v1.6.0) - 2026-07-17

### Features

- Full clip-region boolean ops, gradient brushes, exact ROP2 modes ([efce614](https://github.com/ChristopherVR/emf-converter/commit/efce614b1e4ecfb79f5c6960d11e6c51020cd32f))

### Chores

- **deps:** Bump actions/checkout in the github-actions group ([31661f8](https://github.com/ChristopherVR/emf-converter/commit/31661f8fa9de49ab7266974fef03e91e3b24b9ea))

## [1.5.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v1.5.0) - 2026-06-25

### Features

- Address README limitations — fonts, ROP2, configurable limits ([0513ec6](https://github.com/ChristopherVR/emf-converter/commit/0513ec6db1df6e17d32bb2b00c2c23e724e58076))

## [1.4.3](https://github.com/ChristopherVR/emf-converter/releases/tag/v1.4.3) - 2026-06-24

### Bug Fixes

- PNG generated images not containing any colour ([ac3954c](https://github.com/ChristopherVR/emf-converter/commit/ac3954c06a0bebb550129f02e1a8c8eb54377d35))

### Chores

- **deps:** Bump actions/checkout in the github-actions group ([fe1c4e7](https://github.com/ChristopherVR/emf-converter/commit/fe1c4e77e8467cde52c8ec25b8879c30ddea4f72))

## [1.4.2](https://github.com/ChristopherVR/emf-converter/releases/tag/v1.4.2) - 2026-06-18

### Features

- Add interactive GitHub Pages demo site ([ad4fbe0](https://github.com/ChristopherVR/emf-converter/commit/ad4fbe0675f10ace1dd1c14df330627cb3b3f6ae))

### Documentation

- Standalone README with live demo + correct links ([56d058e](https://github.com/ChristopherVR/emf-converter/commit/56d058e2952eafebd160041131808f9a1f4606ff))

### Build & CI

- Add Dependabot for npm and GitHub Actions ([75855e9](https://github.com/ChristopherVR/emf-converter/commit/75855e9ca5b3cbd710f422a77343dc5232b92ab6))

## [1.4.1](https://github.com/ChristopherVR/emf-converter/releases/tag/v1.4.1) - 2026-06-18

### Testing

- Add grayscale colour-ref fixtures ([3a97fb4](https://github.com/ChristopherVR/emf-converter/commit/3a97fb455fce365b316a8dfb67720c5f18313b78))

### Build & CI

- Changelog-driven npm publish + GitHub release ([f012ca6](https://github.com/ChristopherVR/emf-converter/commit/f012ca6392baf48141433cd541ab22ecd2a50ef4))

## [1.4.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v1.4.0) - 2026-06-18

### Bug Fixes

- Resolve remaining typecheck failures in emf-converter and react ([6b0c632](https://github.com/ChristopherVR/emf-converter/commit/6b0c6325f6f3e10602ac1518fa70bb470de6355a))
- Enable vitest globals in all packages to fix expectTypeOf errors ([554e6d7](https://github.com/ChristopherVR/emf-converter/commit/554e6d76de79c65d785f6767493d6839619b4ea5))
- **test:** Add i18n mocks to react tests and bump versions to 1.2.0 ([51d4a7e](https://github.com/ChristopherVR/emf-converter/commit/51d4a7ee6e3d1d915ea90443d8c67841393b7c11))
- Close security & performance findings from full-codebase review ([6c3a354](https://github.com/ChristopherVR/emf-converter/commit/6c3a3544a3a70c8561b996d3ae7cc6bf582e2543))

### Refactor

- Strongly type XmlObject and eliminate `any` across packages ([57dae97](https://github.com/ChristopherVR/emf-converter/commit/57dae972be03d600c47f66b37e0ea6de954f09a3))

### Documentation

- Rewrite limitations with technical explanations and remove inaccurate claims ([1b3b9ea](https://github.com/ChristopherVR/emf-converter/commit/1b3b9ea98ce06b8dd13e45da3452a73bc8279d05))
- Streamline npm READMEs and add badges, screenshots, demo links ([122e90d](https://github.com/ChristopherVR/emf-converter/commit/122e90dbbec9766e1dac311585f4b96552b2684c))

### Testing

- Add fixture-driven colour-helper coverage ([850b8c5](https://github.com/ChristopherVR/emf-converter/commit/850b8c5159460e99900ce4da94db670782e27a13))

### Build & CI

- Add CI and npm publish workflows ([778a80a](https://github.com/ChristopherVR/emf-converter/commit/778a80af3aaacc4477701b66bd36aec95cc307ab))
- Use OIDC trusted publishing for npm ([f5bcb9c](https://github.com/ChristopherVR/emf-converter/commit/f5bcb9cee0819c9d3fb16dc5ba573327032bbbb5))
- Publish on push to main (self-contained, no release hop) ([39ddc8b](https://github.com/ChristopherVR/emf-converter/commit/39ddc8bfc4302ef6ec38b00b3c673ffb825f64e2))

### Chores

- Add license files, NOTICE, and package metadata for npm publishing ([5ea574b](https://github.com/ChristopherVR/emf-converter/commit/5ea574bc454bb8506dc82560c4c5991848618528))
- Bump all packages to v1.1.0 and remove remaining MyClawAssist refs ([b52dc75](https://github.com/ChristopherVR/emf-converter/commit/b52dc75479dd8ba7d6e2f76830a63689fc3f93bb))
- Fix formatting and lint warnings across test suite ([1f8747d](https://github.com/ChristopherVR/emf-converter/commit/1f8747d10cfb1c174dc5ccbe07604a3b7811c743))
- Repair broken test assertions and clean up lint config ([e6350e5](https://github.com/ChristopherVR/emf-converter/commit/e6350e52f1e7a66160854e86187dc9d02f79221d))
- Bump all packages to 1.x.1 patch versions ([b6a83ee](https://github.com/ChristopherVR/emf-converter/commit/b6a83eebd3f9249f6321f1864d92038d752067b3))
- Bump all packages to minor versions for SDK table support ([55ea3ff](https://github.com/ChristopherVR/emf-converter/commit/55ea3ff5e9960ec8f4fe07fa83e8db151326545e))
- Bump dependencies to latest and minor-bump packages for parity work ([2d8d232](https://github.com/ChristopherVR/emf-converter/commit/2d8d232229cc833fe89ec797226d3d1e8c4d32c1))
- Roll TypeScript back to 5.9.x; quiet new oxlint vitest rules ([76fc469](https://github.com/ChristopherVR/emf-converter/commit/76fc4693b67bc5d42a2e13a60dfadcee54040b46))
- **deps:** Update all dependencies to latest ([9bd123a](https://github.com/ChristopherVR/emf-converter/commit/9bd123a51a14ca1c5c2192e8586db0c7354c9283))
- Relicense from MIT to Apache-2.0 ([4d3f87f](https://github.com/ChristopherVR/emf-converter/commit/4d3f87f141f7eb4345899b8deb6c90b7b34ba0d1))
- Configure standalone repository ([af312ef](https://github.com/ChristopherVR/emf-converter/commit/af312ef79c4cc1acc8c1d4b68d66cef61e43cc1d))


