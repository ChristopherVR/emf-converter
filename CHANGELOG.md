# Changelog

All notable changes to this project are documented here.
This file is generated from [Conventional Commits](https://www.conventionalcommits.org)
by [git-cliff](https://git-cliff.org); do not edit it by hand.

## [4.20.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.20.0) - 2026-10-10

### Features

- JPEG output with a bundled encoder ([fdbf2d0](https://github.com/ChristopherVR/emf-converter/commit/fdbf2d041a0e6b50971815afd6f8849f0c7f57a9))

## [4.19.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.19.0) - 2026-10-10

### Features

- Decode ANSI text with the device ANSI and OEM code pages ([ba534a1](https://github.com/ChristopherVR/emf-converter/commit/ba534a19bef9398cb1f094953214c05026f6c77e))

## [4.18.2](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.18.2) - 2026-10-10

### Bug Fixes

- Support the WMF device ANSI code page (#24) ([7eb9790](https://github.com/ChristopherVR/emf-converter/commit/7eb9790c28dff7dfa923056d72da02821e337b0c))

## [4.18.1](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.18.1) - 2026-10-09

### Bug Fixes

- **emf:** ExtSelectClipRgn regions are in device units ([4f35e26](https://github.com/ChristopherVR/emf-converter/commit/4f35e2629972b9646ae41b51e5c90cdbbc2b25de))

## [4.18.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.18.0) - 2026-10-08

### Features

- Select the HALFTONE enlargement branch from the source and filter exact 2x stretches ([7a793a7](https://github.com/ChristopherVR/emf-converter/commit/7a793a7b123d563cb549c543fc912db4bceb4ebe))
- Shade per-vertex path gradients as Gouraud fan triangles ([4b63d56](https://github.com/ChristopherVR/emf-converter/commit/4b63d5693b79dcf0293326065cfd42f2406b6a4b))
- Ignore FocusScales for per-vertex path gradients ([bb21b21](https://github.com/ChristopherVR/emf-converter/commit/bb21b210382f9a0db7c9b97cb92ecae757989ece))
- Take the path-gradient step count from the untransformed bounds ([f91294d](https://github.com/ChristopherVR/emf-converter/commit/f91294d058a48c711e7c92931c4b90fea7833c06))
- Rasterise the nested copies of a uniform path gradient like GDI+ ([7b7ab80](https://github.com/ChristopherVR/emf-converter/commit/7b7ab806b6bd22d598bf8f22802dbf2eaa12acd3))
- Filter HALFTONE enlargements by 3x to 5x and above, mirrored and under a combined colour adjustment ([ac1f47e](https://github.com/ChristopherVR/emf-converter/commit/ac1f47e419fb41fbf6c583f0a4b761f33ee1d652))
- Give HALFTONE sources of exactly the least row count their own branch rule ([c6f677f](https://github.com/ChristopherVR/emf-converter/commit/c6f677f3913ce0107a5341ac10b8f12a9fc0acb4))
- Filter HALFTONE enlargements of one axis (the other keeps its size) ([6df9b09](https://github.com/ChristopherVR/emf-converter/commit/6df9b09632239ae0deff5dab0407034f6b788551))
- Filter fractional HALFTONE enlargements up to 5x by source-pixel runs ([cb77899](https://github.com/ChristopherVR/emf-converter/commit/cb778997c2f939f8c70ca2bba5daf55401f082b2))
- Use the measured integer weights for upscaled HighQualityBicubic axes ([c86586b](https://github.com/ChristopherVR/emf-converter/commit/c86586b03621ee3e168cc64a317448afe6f23ca9))
- Draw high-quality reductions from texel edges quantised in destination space ([794245a](https://github.com/ChristopherVR/emf-converter/commit/794245a59ee672f318b2c4be0707ffd1667bebd9))
- Mirrored axis-aligned high-quality draws, unsnapped phase offsets, and a phase capture that pins them ([cec18d5](https://github.com/ChristopherVR/emf-converter/commit/cec18d587ab97a3c59c2ebda7f0f9dbbe758cebb))
- WrapMode on axis-aligned and rotated high-quality draws ([5df1aa0](https://github.com/ChristopherVR/emf-converter/commit/5df1aa0fc6e7c88498f21fa9851cc1f16cd4f5db))
- Snap only the first corner of a rotated high-quality draw ([276f3af](https://github.com/ChristopherVR/emf-converter/commit/276f3af7e09b6de0375be5a70f4d541e516a7ada))
- Decide path-gradient copy-edge ties from the binary fixed-point ratio and the position along the edge ([a64ad8b](https://github.com/ChristopherVR/emf-converter/commit/a64ad8b3750c3c4ca2cc63c7c61b1a4ec9af3098))
- Decide independent-FocusScales copy-edge ties by the scaled copy's own edges and the uniform tie rules ([549f2c1](https://github.com/ChristopherVR/emf-converter/commit/549f2c1b29ea22a6f1d2b8ddd25aeda41a62174d))
- Draw tiled path gradients with fractional bounds as a rounded-size bitmap texture with a bilinear filter ([bcc60c8](https://github.com/ChristopherVR/emf-converter/commit/bcc60c82d0b16fa714a0db3bc9c5a4ca18d07eb9))
- Compute GDI arc points in single precision ([4569c0c](https://github.com/ChristopherVR/emf-converter/commit/4569c0c1ea4adf1138350bd9b1da09ee3880418b))
- Turn a curve's last join along its end tangent when it opposes the last segment ([4a2e470](https://github.com/ChristopherVR/emf-converter/commit/4a2e4709ecbb1a038043ce0119db4dfaf3392803))
- Cut dashes and extend their square caps in single precision ([6b7205e](https://github.com/ChristopherVR/emf-converter/commit/6b7205e3122bcdade1c70e19f15edf1f1c31752f))
- Lay out dashed pens under a world scale in whole logical units ([f8b08fc](https://github.com/ChristopherVR/emf-converter/commit/f8b08fc834f99a04cbc0ac30d46516ddcc947ac1))
- Use the digital pens for a narrow pen under a rotation with a uniform scale ([44b9e11](https://github.com/ChristopherVR/emf-converter/commit/44b9e11ba40521328652729228a910008cf41d50))
- Measure dashes under a rotated matrix in whole logical units ([82574f5](https://github.com/ChristopherVR/emf-converter/commit/82574f5bc7711056b1aa768e689c870c1fe01a24))
- Model red-eye correction with integer luma weights, the 2/9 darkness, an exact carry and strength steps ([fa2e09b](https://github.com/ChristopherVR/emf-converter/commit/fa2e09bb7b1d8601e3bf9945af4b9ac6dbc52eb0))
- Leave at most 5 x distance^2 levels of redness around a red-eye highlight ([b1e2e76](https://github.com/ChristopherVR/emf-converter/commit/b1e2e76ce13207b941d57138b50366b9338f2c3a))
- Carry the previous red-eye area's centroid in pixel-index coordinates ([dc4c516](https://github.com/ChristopherVR/emf-converter/commit/dc4c516376298c8641d32999ffc85a29e759870b))
- Apply native's size-specific x SHPIX tweaks in ClearType hinting ([22b870c](https://github.com/ChristopherVR/emf-converter/commit/22b870c030577c06cda593dacf9f156a2c33c811))
- Ignore y DELTAPs once IUP[y] has run, in ClearType and grayscale ([d7f2330](https://github.com/ChristopherVR/emf-converter/commit/d7f23307a450e083343fad609847df25f8198aae))
- **gdi:** Pick the HALFTONE mixed enlarge-and-reduce engine by the 1.5x reduction, the destination area and the filtered source; despeckle only outside 2,305 to 16,384 source pixels ([db67045](https://github.com/ChristopherVR/emf-converter/commit/db670458ff719b8807f1e450a5992fa036e3a0d1))
- **gdi:** Closed-form HALFTONE enlargement kernel and a despeckle before mild both-axes reductions ([e51f6a3](https://github.com/ChristopherVR/emf-converter/commit/e51f6a335184c3c277c851c51b29660bcd5c6bf2))
- **gdi:** HALFTONE reduction of one axis (13-bit shares, sharpened along that axis, despeckled like the both-axes reduction) and the dithered one-axis adjustments ([494939f](https://github.com/ChristopherVR/emf-converter/commit/494939f1bf7e37b3ac96d7f3d5b8d040baa057f7))
- **gdi:** Dither the source of a mixed HALFTONE stretch when the destination has at least as many pixels as the source, the finished output otherwise ([7b72bb9](https://github.com/ChristopherVR/emf-converter/commit/7b72bb92f4bc84e228c7c13090f8978298f6996b))
- **redeye:** Fresh-process captures close the process-state, fallback-falloff and luma-0 items ([acd6b53](https://github.com/ChristopherVR/emf-converter/commit/acd6b533cf5b30a51d2897be3a0c920bb821886e))
- **gdi:** Rotated pen nib as an Ellipse box of the half-width images, and its perpendicular rules ([7b7724b](https://github.com/ChristopherVR/emf-converter/commit/7b7724ba5cec8ad43c4e0e01ba106eaed50492d5))
- **gdi:** Test the miter limit of a matrix pen in logical units ([64f4e2c](https://github.com/ChristopherVR/emf-converter/commit/64f4e2c0bd0483cb3fb03fd0f29de4a77d5b8aee))
- **gradient:** Apply an isotropic focus in absolute device coordinates ([55de46a](https://github.com/ChristopherVR/emf-converter/commit/55de46ac392685d07547350be8ca9fd1df3dbfd7))
- **gdi:** Apply the measured native ties of the HALFTONE chroma stage for eleven colorfulness / tint settings ([b4bafde](https://github.com/ChristopherVR/emf-converter/commit/b4bafde837b4ebf6a242acf75fd58004d637e413))
- **text:** Widen GDI+ ClearType sample rows for the system Courier New ([e3544bd](https://github.com/ChristopherVR/emf-converter/commit/e3544bd1e26b9166be175a12c499180ad63d4f01))
- **text:** ClearType dropout control from the font's SCANCTRL ([717d205](https://github.com/ChristopherVR/emf-converter/commit/717d2054327451bf43576dabd305368da019a36e))
- **text:** Read storage 8 as 0 under backward-compatible ClearType ([3efe721](https://github.com/ChristopherVR/emf-converter/commit/3efe721980b77259d601b5e1b7aa7f1c92bab102))
- **text:** Grayscale stub dropout (SCANTYPE 1 and 5) without the overshoot exemption ([b44e151](https://github.com/ChristopherVR/emf-converter/commit/b44e151e13da01e68547f77892b1c759452a1e4b))

### Bug Fixes

- Explain the System/Fixedsys raster difference as the 8514 faces and make Fixedsys exact ([3e4aa75](https://github.com/ChristopherVR/emf-converter/commit/3e4aa75820d299d25dcda4ae828eef4adc045b79))
- Keep only the centre-pixel axis rule for red-eye sectors ([5a9f5a0](https://github.com/ChristopherVR/emf-converter/commit/5a9f5a00c3a983de47e05f4d36db458b1547e5bc))
- Keep the previous red-eye centroid weights where the luma weights raised a residual ceiling ([1df56a9](https://github.com/ChristopherVR/emf-converter/commit/1df56a99cb8e39063b5eeb69e57811c6cb2a5f0e))
- Reset the TrueType instruction budget per program ([658323a](https://github.com/ChristopherVR/emf-converter/commit/658323a41c6a31443852f440de29d32b0a4d433c))
- Honour the default and SCANTYPE 0/4 dropout control in the scan converter ([7fe76c6](https://github.com/ChristopherVR/emf-converter/commit/7fe76c6c624dcacac7929b33cbf24b161cea7130))
- **emf-plus:** Cropped vertical margin, DrawImage versus DrawImagePoints, mirrored unit-scale axes ([3241554](https://github.com/ChristopherVR/emf-converter/commit/3241554de8717ece2bddc502bede5ed6f032b3b7))
- **emf-plus:** Close the positive phase boundary of the unit-scale Bicubic copy ([ad8aa5e](https://github.com/ChristopherVR/emf-converter/commit/ad8aa5e344e990837ae565d4f83ba9e1b29cfe7c))
- Scale rotated glyphs by GDI's rounded-major rotation matrix ([1b36738](https://github.com/ChristopherVR/emf-converter/commit/1b367382da01296f696db7b56662d6dbb4bbebd7))
- Stretch raster faces up to 8x vertically and 5x horizontally ([a6aaa07](https://github.com/ChristopherVR/emf-converter/commit/a6aaa07dbfd0a110e90d123106ad3c13811635ed))
- **emf-plus:** Leave pixels outside the nested-copy boundary unpainted; pin that pens, text and fills take the brush path's copies ([6c5ba2a](https://github.com/ChristopherVR/emf-converter/commit/6c5ba2a669ff9d95dc6ac1d14340c2865fe9a8a1))
- **emf-plus:** Decide the copy of every uniform path-gradient pixel with float32 arithmetic rounded toward minus infinity ([dc8f1d0](https://github.com/ChristopherVR/emf-converter/commit/dc8f1d06136aaa704291e06d107ffdea1a36cdac))
- **gdi:** Compat shapes against native playback: cosmetic rectangle edges ceil, null-pen growth on whole-pixel boxes ([64ce91e](https://github.com/ChristopherVR/emf-converter/commit/64ce91e7e6f2a875699fa5f92d209e6641cb2816))
- **gdi:** Bevel/miter joins under matrices in device space; EMF+ inset ring and compound band corners on closed figures ([521f55d](https://github.com/ChristopherVR/emf-converter/commit/521f55d494d60dc4b29d993bffa93e016554d35d))
- **gdi:** Single-precision tangent lines for small arcs where the cancellation reaches half a FIX ([19ee0a4](https://github.com/ChristopherVR/emf-converter/commit/19ee0a4715acc211186942722cda3521d09a0498))
- **gdi:** Round a matrix pen's square-cap extension ties away from zero ([a8932ae](https://github.com/ChristopherVR/emf-converter/commit/a8932ae9832e9ef76a0250bfab3c0a9d1e6f2288))
- **gdi:** Measure Arc, Chord and Pie radials in logical space under non-unit maps ([d9568e0](https://github.com/ChristopherVR/emf-converter/commit/d9568e0b2ed2e04c22340f061ab07aea03c84f43))
- **gdi:** Reproduce Arc, Chord, Pie, RoundRect and Rectangle under maps that mirror an axis ([b3ceb77](https://github.com/ChristopherVR/emf-converter/commit/b3ceb771a9cd8fcd6fc1f9c1bffdeb89fb568d4d))
- **gdi:** A clockwise arc from the 0 axis is a small arc; capture arcs on boxes of up to 2^24 pixels ([a3ac070](https://github.com/ChristopherVR/emf-converter/commit/a3ac070c6ccbef96015f374df2c4a78fc617f883))
- **gradient:** Accumulate the path-gradient step ramp from the centre in float32 rounded down ([1d95fff](https://github.com/ChristopherVR/emf-converter/commit/1d95fff459372db8fb1f2721f9b58e41a6644a9a))
- **gdi:** Pad a dithered filtered HALFTONE enlargement with two replicas of each edge row so the extension rows sharpen against the replicated, separately dithered edge ([6d3eb36](https://github.com/ChristopherVR/emf-converter/commit/6d3eb362b75b02e688b0534e57140d03de3bf909))
- **gdi:** Sharpen the last row of a vertically mirrored dithered mixed enlargement against the further dithered row too ([af67da2](https://github.com/ChristopherVR/emf-converter/commit/af67da216d92af0339b57620b980a8a32f5938e4))
- Use the metafile extent as the codec-jpeg playback reference ([06fbcd5](https://github.com/ChristopherVR/emf-converter/commit/06fbcd5d1dcc499b945f73dc03bbb977028006b1))
- **text:** Apply the ClearType MSIRP cut-in along x only ([70a840c](https://github.com/ChristopherVR/emf-converter/commit/70a840c5b6137637ac4c4fb823088da818eb5159))

### Reverts

- Drop the ClearType dropout control (rule 2: it makes two exact size-sheet captures inexact) ([b4ffa94](https://github.com/ChristopherVR/emf-converter/commit/b4ffa948f34b749e545f3920819b381f49b35ec2))

### Other

- Merge origin/main into the path-gradient worktree ([8ff5316](https://github.com/ChristopherVR/emf-converter/commit/8ff5316b5f39700b8e9ef3f10d878f5e0f8c386e))
- Merge origin/main into the HALFTONE branch-selection worktree ([5af3697](https://github.com/ChristopherVR/emf-converter/commit/5af36976af55b14c58c622fe248fac432aa4a349))
- Revert "revert: drop the ClearType dropout control (rule 2: it makes two exact size-sheet captures inexact)" ([63d6f3c](https://github.com/ChristopherVR/emf-converter/commit/63d6f3c1b1d767248d260c7c93a95b8195f838fc))

### Documentation

- Update the measured test count and the superseded path-gradient numbers ([a872a7a](https://github.com/ChristopherVR/emf-converter/commit/a872a7acfc5b6566b45f12a49939caeeaf78984b))
- Record the filtered HALFTONE engines, the exact-height give-up rule and what stays open ([7c4c95b](https://github.com/ChristopherVR/emf-converter/commit/7c4c95be34603211ab8ea0d5d254b9bdd399721e))
- Record the round 4 high-quality DrawImage rules, rejections and open data ([38bbb83](https://github.com/ChristopherVR/emf-converter/commit/38bbb831d8f80fd671b28d22d7056c9cd4fa95ab))
- Mark which round 4 pen figures are analyses of committed captures ([a772e97](https://github.com/ChristopherVR/emf-converter/commit/a772e97eb7b50299edf051785008a9377856dd81))
- Record the red-eye stage rules, the new exact counts and what history-dependent areas need ([be42f4e](https://github.com/ChristopherVR/emf-converter/commit/be42f4e7fb4139a81e4180ea5628ebd3850690f9))
- Resolve the priorities table row shared by the HALFTONE and red-eye rounds ([57a5e00](https://github.com/ChristopherVR/emf-converter/commit/57a5e0025bccb8d63ab0606c2d7612c08775d8a7))
- Update generate.ps1 header to list all standalone probe modes ([c2d7048](https://github.com/ChristopherVR/emf-converter/commit/c2d70485074546cdc37dca131991c6a5369916b4))
- Update README.md probe modes list to include all standalone modes ([3224e7c](https://github.com/ChristopherVR/emf-converter/commit/3224e7c8642c608e984eaa38f746c8914a461dde))
- Fix README.md probe modes list to include path-probe, dash-neighbourhood-probe, and bicubic-independent ([3ba60bb](https://github.com/ChristopherVR/emf-converter/commit/3ba60bbff44ea2ef9cc5414c490446e0e7dbcf2a))
- Reconcile limitations and outstanding work after round 4, refresh the parity report figures ([e1a9171](https://github.com/ChristopherVR/emf-converter/commit/e1a91718a3a384e6aa87eebd20d47c3df5b6cf1f))
- Record the post-IUP move probe and the ALIGNRP lead ([d7e2c36](https://github.com/ChristopherVR/emf-converter/commit/d7e2c36cc0e6c43df1bb80d5ad35dc7cffdaa688))
- Record the dropout-control rules, the run-to-run change in native glyph output and the rejected hinting hypotheses ([cd54b55](https://github.com/ChristopherVR/emf-converter/commit/cd54b5533d4c7ee536236c52707cb76ce5c68094))
- Refresh the suite size after the grayscale dropout round ([89579d4](https://github.com/ChristopherVR/emf-converter/commit/89579d49259ce90069dc36fa064d212b808aae5f))
- Record the rejected anisotropic-focus models of round 5 ([21ea0c1](https://github.com/ChristopherVR/emf-converter/commit/21ea0c13197bd2ebda096d24370dda0c5d728537))
- Unescape apostrophes in the round 5 anisotropic-focus paragraph ([5e355bb](https://github.com/ChristopherVR/emf-converter/commit/5e355bbdaf6bc762fc5e880febc454cfb52af8d5))
- Correct the gpx-text-pathgrad figure to the parity test's 0.692% ([e75b292](https://github.com/ChristopherVR/emf-converter/commit/e75b292c9f72eb793a8818d3c86fa05bff9e51df))
- Close the HALFTONE selection sweeps at reducing, fractional and wide scales ([2b071a9](https://github.com/ChristopherVR/emf-converter/commit/2b071a9a0edb70d99b8403e2137641805ef975be))
- Resolve the conflict markers left in the V5 merge (priorities row 3, README probe-mode list) ([9aa6bcc](https://github.com/ChristopherVR/emf-converter/commit/9aa6bcc12942a3ae714150ff47c565c3f677076d))
- **gdi:** Dash walk distance does not move native cuts (lengthened-run capture) ([68cfb12](https://github.com/ChristopherVR/emf-converter/commit/68cfb12068a1e8a73ccdb38ab9c690a9a6bb3743))
- **gdi:** One-degree nib sweep rejects the vertex-index rule for the rotated pen nib ([c6f5848](https://github.com/ChristopherVR/emf-converter/commit/c6f5848908191bb3f05112e906732325a1fb2625))
- Resolve the conflict markers left in the V7 merge (round-5 sections inserted at one point) ([d2f370b](https://github.com/ChristopherVR/emf-converter/commit/d2f370b0425e7aee3f2c7ab6a520cfd6328c75e4))
- Record the suite size after the red-eye and CMYK round ([d0caf8a](https://github.com/ChristopherVR/emf-converter/commit/d0caf8a985e759874d9f5a3983cd4b4c95b2d8b1))
- Reconcile the round 5 merges (priorities table, probe-mode lists, report and suite figures, stale counts) ([4daa2ca](https://github.com/ChristopherVR/emf-converter/commit/4daa2ca34a8426c9e0c74455c935a910d4318bf1))
- Record the round 6 geometry workstream figures (suite, report, bundle) ([1ee8592](https://github.com/ChristopherVR/emf-converter/commit/1ee8592f35134f3d622a09f835afcbeae9ef6bd5))
- Update the suite figures after the path-gradient leftovers ([0cf4bb0](https://github.com/ChristopherVR/emf-converter/commit/0cf4bb0218ab137fd7325d44a3d0fffeafb602a6))
- Record the scratch playback of the references that are larger than the render ([efbcc8e](https://github.com/ChristopherVR/emf-converter/commit/efbcc8e8221cb38d7b7f9178324d345290866c9d))
- Suite figures after the reference coverage workstream ([4eb7b08](https://github.com/ChristopherVR/emf-converter/commit/4eb7b0802d6414db51e3c345a66e43acfa7caeb9))
- Record where the stub overshoot exemption stays ([28c2ae8](https://github.com/ChristopherVR/emf-converter/commit/28c2ae81fccd925ccbf47888d7c0a9b74c1d9559))
- Record the default dropout control of fonts without SCANCTRL under ClearType ([1d838bc](https://github.com/ChristopherVR/emf-converter/commit/1d838bc742a0de20d59c04ae1b24e3665dbfa0df))
- Re-measure the grayscale default dropout of fonts without SCANCTRL ([db1cef4](https://github.com/ChristopherVR/emf-converter/commit/db1cef4c48a332931d331aeb77d8a1293960f34d))
- State the reinstated ClearType dropout control counts (3,059 of 3,720, 1,114 Courier) and the two accepted losses ([62045e7](https://github.com/ChristopherVR/emf-converter/commit/62045e7ec23d20aa980cf51b31c90009eb865c51))
- Reconcile limitations, outstanding work and the fixture README after round 6 ([5bb2300](https://github.com/ChristopherVR/emf-converter/commit/5bb2300b47331e8a3bbc3b847989fdf759796f5b))

### Testing

- Add the HALFTONE branch boundary probe, sweeps and native labels ([480224c](https://github.com/ChristopherVR/emf-converter/commit/480224c4fa35b36f433565721bfadea94a59261d))
- Pin the varying-surround alpha captures at their Gouraud counts ([85fe677](https://github.com/ChristopherVR/emf-converter/commit/85fe67775e8f7997fcfcc50cb18ea0905eb6ec42))
- Capture pixels exactly on a nested copy's edge ([399fb84](https://github.com/ChristopherVR/emf-converter/commit/399fb8433b2227d0d2acc5e9b52cff50361b3a5a))
- Tighten the high-quality image parity cases to one level ([f69dda2](https://github.com/ChristopherVR/emf-converter/commit/f69dda21d172badf4809440091c658c1c37e3eb0))
- Explain the Segoe UI playback hinting difference as the eyScale/exScale text stretch ([e13261a](https://github.com/ChristopherVR/emf-converter/commit/e13261a582c8f6a9a24c4725c34664a326545b72))
- Explain the rotated text recording as 1/16-pixel running advances ([d3fe330](https://github.com/ChristopherVR/emf-converter/commit/d3fe3308e366b6730d9f60433749685db3f6d0a6))
- Pin what the per-product projection candidate gains and loses on real GDI+ glyphs ([ec0bcd5](https://github.com/ChristopherVR/emf-converter/commit/ec0bcd5866cb1bcb7b0f66fc73fac0d4a3ee7d50))
- Add the red-eye stage probe, its captures and the stage regression tests ([df35ec6](https://github.com/ChristopherVR/emf-converter/commit/df35ec637229001774ce9835f6c260320975b67b))
- Add explicit 120s timeout to load-dependent SVG and raster test files ([556ea60](https://github.com/ChristopherVR/emf-converter/commit/556ea60c9c4d284b313bb9a9cb8adb765ea40a65))
- Pin the ClearType x SHPIX rule on private diagnostic fonts and match the helper bodies exactly ([d7d9455](https://github.com/ChristopherVR/emf-converter/commit/d7d9455bccadd691e0af7145e6a4eabba01dd118))
- Native captures showing scan-conversion defaults and run-to-run changes in native glyphs ([ded92a1](https://github.com/ChristopherVR/emf-converter/commit/ded92a1375fd45378fc9b5ad4d4f675f67194d42))
- Pin which heights a playback stretch re-grid-fits, and the rule behind it ([b52b041](https://github.com/ChristopherVR/emf-converter/commit/b52b041ddd310ddd9e0bbb7b6e997ec8e300dfdd))
- **emf-plus:** Pin the tip pixels of uniform path gradients with a native 1/16-offset sweep ([3dac2a7](https://github.com/ChristopherVR/emf-converter/commit/3dac2a726b734255e60f366d34e650721e6c6700))
- **emf-plus:** Pin large path gradients at fractional vertices and the open step-colour rounding ([3468d7a](https://github.com/ChristopherVR/emf-converter/commit/3468d7a7d5c150a0897631783eaa152afa2a6c5a))
- **gdi:** Verify the HALFTONE despeckle brightness weights, tie side and dense checker runs against 6,400 native blocks and 500 images ([a740cc5](https://github.com/ChristopherVR/emf-converter/commit/a740cc55e35e1adefa59927d1e3ef89b2938ed0f))
- **gdi:** Tighten the two mixed-axis colour-adjusted HALFTONE ramp bounds ([f454761](https://github.com/ChristopherVR/emf-converter/commit/f45476146109f311f168b3b95402ad802e24700a))
- Pin red-eye history dependence across fresh Windows processes (stateless first-call behaviour) ([249d5db](https://github.com/ChristopherVR/emf-converter/commit/249d5dbd5baa1bcd729c777dbf49229760f1caff))
- Pin the CMYK edge sweep of the Windows ICM module (blocks of 16 words, no common rounding position) ([c5521bc](https://github.com/ChristopherVR/emf-converter/commit/c5521bc47f6b09b7f8f2468f2cd7738ebef91ee9))
- Pin that the 48 inexact DrawString placement captures are glyph shapes, and record the playback-stretch decision ([1691cc0](https://github.com/ChristopherVR/emf-converter/commit/1691cc096ebf323c0a48875712122aa390b900c6))
- **gdi:** Capture mirrored matrices for the rotated pen (sweeps and miter corners) ([43a0b58](https://github.com/ChristopherVR/emf-converter/commit/43a0b58c18d080f1631b4f8d31213d1a48a4cb3d))
- **gradient:** Capture tiled path gradients under rotation and shear ([feb3216](https://github.com/ChristopherVR/emf-converter/commit/feb3216e26fc604b35d43cccfee8699df5e8c4f5))
- Capture the 1.37x and 1.55x step grid and record the negative result for the reciprocal step ([1699b25](https://github.com/ChristopherVR/emf-converter/commit/1699b257b9f592683cebe435faba95f9bc7d06de))
- **gdi:** Pin that the HALFTONE kernel ties are ridges and not defects, label 4,773 near-integer shares, drop the factor-15 centre row, and record alpha dropped under HALFTONE ([df77dc2](https://github.com/ChristopherVR/emf-converter/commit/df77dc25402550281ea029bca4a14784b836c016))
- Capture native playback of the seven compat-playback sheets into larger surfaces ([6919284](https://github.com/ChristopherVR/emf-converter/commit/6919284bf178350e43f84955ed96c0cd1b5ebc48))
- Survey native playback of every fixture whose extent exceeds its reference ([fa1e06d](https://github.com/ChristopherVR/emf-converter/commit/fa1e06dd2f9e8daf2d3f96503a6cd9d946a093ca))
- **text:** Record that native honours ALIGNRP around the IUPs ([4cc719a](https://github.com/ChristopherVR/emf-converter/commit/4cc719a597bcf5f32f6ba9144c4b1928b13eab55))
- Allow 60 s for the 5,841-chord widening sweep ([817c416](https://github.com/ChristopherVR/emf-converter/commit/817c416caee1bd616dd3f5c46adffd3c621eff7d))
- Don't build Windows-font fixtures inside skipped describe bodies ([6b0e9ad](https://github.com/ChristopherVR/emf-converter/commit/6b0e9ad2cf41532d5b5878da6212a691f4643a24))

### Chores

- Complete THIRD_PARTY_NOTICES for the libjpeg-derived decoder and measured data ([164d6a8](https://github.com/ChristopherVR/emf-converter/commit/164d6a8627c2f6b0c30a1caa26e9e93ca8477856))
- **gdi:** Let the mixed-engine render helper take the log filter ([1076da0](https://github.com/ChristopherVR/emf-converter/commit/1076da069ac05d7de18bb2f70454dcd097275442))

## [4.17.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.17.0) - 2026-10-08

### Features

- **cmyk:** Place inks on the grid by the profile input curve, refit the ICM table ([23e721c](https://github.com/ChristopherVR/emf-converter/commit/23e721c764f40335fd5db1d5f1e077fe41fae330))

### Other

- Merge origin/main into the CMYK input-curve worktree ([fb57be9](https://github.com/ChristopherVR/emf-converter/commit/fb57be9dd564c598396fb674419e59770bd70a35))

### Documentation

- Soften the node claim in the CMYK open-work paragraph ([2ae0372](https://github.com/ChristopherVR/emf-converter/commit/2ae0372d8451be07f60c440996630291f7985bc5))
- Update the measured test count after the CMYK round ([aba148f](https://github.com/ChristopherVR/emf-converter/commit/aba148f5690f01f23d7da290ef1f1ad7a1db8d1c))

## [4.16.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.16.0) - 2026-10-08

### Features

- **emf-plus:** Model rotated high-quality DrawImage as a pre-scale plus a plain Bicubic or Bilinear pass ([b772949](https://github.com/ChristopherVR/emf-converter/commit/b7729492e671439a3fd2088efa6d6faf02ca59bf))
- **emf-plus:** Pixel-centre fill rule and premultiplied intermediate for the rotated high-quality second pass ([fca5166](https://github.com/ChristopherVR/emf-converter/commit/fca516608ecabd705fe874f76bfd5fb00690515d))
- **emf-plus:** Phased high-quality axis arithmetic, near-axis-aligned quads and alpha, with native rotated captures ([9ce58c5](https://github.com/ChristopherVR/emf-converter/commit/9ce58c5a2a5d133de6f885128ec7828312b730bf))

### Other

- Merge origin/main into the high-quality DrawImage worktree ([deb1ee9](https://github.com/ChristopherVR/emf-converter/commit/deb1ee988b4afa6e31a3b6ee15cb56003a3ad70d))

### Documentation

- Record the two-pass rotated high-quality DrawImage model and what stays open ([5b4f05f](https://github.com/ChristopherVR/emf-converter/commit/5b4f05ff29d7956c56471de259e6315232803168))

## [4.15.2](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.15.2) - 2026-10-08

### Bug Fixes

- **emf:** Play RoundRect records the same in every graphics mode ([456e91b](https://github.com/ChristopherVR/emf-converter/commit/456e91bf9834d53f2b9a8d106faab8da90655392))
- **gdi:** Round the scaled cap cut away from zero and widen at the pen's FIX width ([05c11bd](https://github.com/ChristopherVR/emf-converter/commit/05c11bd9467080909c238a343300c1c8f4ecab86))
- **gdi:** Loop flat caps round the pen between a curve's inner sides; isolate samples 206 and 117 ([5c35d85](https://github.com/ChristopherVR/emf-converter/commit/5c35d85fae1a026813fd8ac9a8af0c7ce81b22f9))

### Other

- Merge origin/main into worktree-agent-a2631764e45a78b7a ([a4b1428](https://github.com/ChristopherVR/emf-converter/commit/a4b1428e1a2a61372c67c17c9b8b9f56b79a535d))

### Documentation

- Update the measured test count after the pen and RoundRect playback round ([038819d](https://github.com/ChristopherVR/emf-converter/commit/038819d8d97abe467a0a3999a19333b89be0bf53))

## [4.15.1](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.15.1) - 2026-10-08

### Documentation

- Update the measured test count after the text regeneration round ([9d399ea](https://github.com/ChristopherVR/emf-converter/commit/9d399eab2e57e4f2fc1d5b9250324a4086ae6759))

### Testing

- Regenerate the nine clipped text references and pin why seven stay unchanged ([7f59ba5](https://github.com/ChristopherVR/emf-converter/commit/7f59ba51141dbb896625acb435e9c21448391da4))

## [4.15.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.15.0) - 2026-10-08

### Features

- Quantise path-gradient colour into GDI+'s nested contour steps ([bd7d703](https://github.com/ChristopherVR/emf-converter/commit/bd7d7034d93ad6174b861f4638266b6872a15f94))

### Documentation

- Record the path-gradient step rule and what stays open ([a007563](https://github.com/ChristopherVR/emf-converter/commit/a00756369d48d131791ed09eec1d0ca19b8124bf))
- Update the measured test count after the path-gradient round ([e0c550b](https://github.com/ChristopherVR/emf-converter/commit/e0c550b1ea831231985e5d60cfa8647b3439d9d3))
- Record the ellipse-clamp two-level pixels left by the path-gradient step rule ([bc8ba07](https://github.com/ChristopherVR/emf-converter/commit/bc8ba075babc7f4a2935accaf90692dd47b82c4f))

## [4.14.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.14.0) - 2026-10-07

### Features

- Square caps and pen widths under world scales, rotations and anisotropic maps ([e8fd124](https://github.com/ChristopherVR/emf-converter/commit/e8fd12449d72d9cfb483c0251a7c4222229831d8))

### Bug Fixes

- Widen a one-segment chord as a closed two-vertex polygon ([0ba7909](https://github.com/ChristopherVR/emf-converter/commit/0ba7909144d060871120103296e5eb5267cabfd6))
- Keep zero-length dash pieces and exact lengths in wide dashed curves ([a1e9013](https://github.com/ChristopherVR/emf-converter/commit/a1e901399e8903a309d6b29c131fbbf4cf9d16c3))
- Scale the RoundRect corner onto the drawn box under a wide pen in compatible playback ([dc30865](https://github.com/ChristopherVR/emf-converter/commit/dc30865f363fe221bc697cd7f9233c4094f7e014))

### Documentation

- Update the measured test count after the curve-pen and CMYK rounds ([8b2c642](https://github.com/ChristopherVR/emf-converter/commit/8b2c64211935ac75df6db3c7d4adff5283c7f587))

## [4.13.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.13.0) - 2026-10-07

### Features

- Replace the fitted CMYK grid with the Windows ICM table; decode CMYK JPEG in TIFF ([b58db02](https://github.com/ChristopherVR/emf-converter/commit/b58db02fe25d1fb531a694ed7a4cc9417d6b5a39))

### Other

- Merge origin/main into R1 CMYK branch ([381109d](https://github.com/ChristopherVR/emf-converter/commit/381109d738df7b10acf673eee236315fdf1498bd))

## [4.12.2](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.12.2) - 2026-10-07

### Documentation

- Record the nine clipped-reference extent verdicts ([c043140](https://github.com/ChristopherVR/emf-converter/commit/c0431406a868d14208d369e206cad9ba627e4962))
- Update the measured test count after merging the extent and arithmetic-JPEG rounds ([7e3c32e](https://github.com/ChristopherVR/emf-converter/commit/7e3c32e482e4521cb1723247f657b3cb5d20b6e2))

### Testing

- Validate two more native playback extents and pin the nine clipped text references ([777f6ff](https://github.com/ChristopherVR/emf-converter/commit/777f6ff0afeaba2b02b78d6164509658e8b3f46e))

## [4.12.1](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.12.1) - 2026-10-07

### Testing

- Verify arithmetic JPEG against 28 encoder-made native captures ([72ab73e](https://github.com/ChristopherVR/emf-converter/commit/72ab73e0451b91c3b5237a4a32c875845d9f6b4a))

## [4.12.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.12.0) - 2026-10-07

### Features

- Add MAC_CHARSET (77) support to ANSI text decoding ([d12a085](https://github.com/ChristopherVR/emf-converter/commit/d12a08564ee97a8f8ca3aa39ccf867dfab67cc10))
- Decode arithmetic-coded, CMYK and YCCK JPEG; refuse 12-bit JPEG as Windows does ([499589b](https://github.com/ChristopherVR/emf-converter/commit/499589b5dde931ba3ea1067c59fc2c48b18ce635))

### Bug Fixes

- Widen arc, chord and pie ends like WidenPath (whole-pixel cap extension, line-to-curve tangent corners) ([f196e54](https://github.com/ChristopherVR/emf-converter/commit/f196e5496725375f87658b5bc812e93fb3b2666c))
- Apply the whole-pixel cap extension to every segment at unit scale; add the arc end-angle sweep capture ([97c5174](https://github.com/ChristopherVR/emf-converter/commit/97c5174d36223752336fbae06e3ec6601ad9fb5a))

### Refactor

- Type curve end tangents as [x, y, role] and fix a missing space ([b598485](https://github.com/ChristopherVR/emf-converter/commit/b59848591497c0997b9eeb97ed8ddc64887987ff))

### Documentation

- Fix intro structure, parity numbers, and mojibake in documentation ([39e908b](https://github.com/ChristopherVR/emf-converter/commit/39e908b27cf6f97fe434ab4c033e7c8bece752c9))
- Fix factual errors in parity documentation ([64636e6](https://github.com/ChristopherVR/emf-converter/commit/64636e65b26cca43e0aba5f34401f4a5e276f087))
- Update limitations for complete ANSI charset support ([9f8a4b5](https://github.com/ChristopherVR/emf-converter/commit/9f8a4b51640f98f4782502b70383bced2cabd0af))
- Correct ANSI charset decoding description ([155bc57](https://github.com/ChristopherVR/emf-converter/commit/155bc5764a7df6cc9a59a8068dced464a68f207f))

### Testing

- Add comprehensive charset coverage tests for ANSI decoding ([eea49bc](https://github.com/ChristopherVR/emf-converter/commit/eea49bcbefd71988ed02e97e05fc30c0e12f081c))
- Pin CMYK, YCCK, arithmetic and 12-bit JPEG against native captures; docs ([6c5fd00](https://github.com/ChristopherVR/emf-converter/commit/6c5fd006d5d350176e75891dc3b8a86c19d6e14d))
- Allow 60 s for the 92-case playback-extent sweeps ([a08a5b7](https://github.com/ChristopherVR/emf-converter/commit/a08a5b7d43fe6674174a58ddd253e31a78103843))

## [4.11.3](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.11.3) - 2026-10-06

### Bug Fixes

- Build the SVG tree without spreading every top-level node into push() (#23) ([93123c2](https://github.com/ChristopherVR/emf-converter/commit/93123c2804a3164676c8ad6057a0e13e2015dd0e))

## [4.11.2](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.11.2) - 2026-10-06

### Documentation

- Record what was ruled out for the rotated-pen nib and perpendicular rounding ([3faaf02](https://github.com/ChristopherVR/emf-converter/commit/3faaf02094ba99ec4aa8ec75ae00fbfb9e48cffd))

## [4.11.1](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.11.1) - 2026-10-06

### Testing

- Pin native rotated-pen perpendiculars with a direction sweep ([d5e2bfc](https://github.com/ChristopherVR/emf-converter/commit/d5e2bfc271231434bf9b91785ef8c549883084d5))

## [4.11.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.11.0) - 2026-10-06

### Features

- Widen rotated/sheared pens in device space with the matrix's own nib ([99ba022](https://github.com/ChristopherVR/emf-converter/commit/99ba02282809e97f2c4a97487518940bcee0b47f))

## [4.10.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.10.0) - 2026-10-06

### Features

- Widen pens under rotated/sheared matrices as a circle in logical space ([cb673e9](https://github.com/ChristopherVR/emf-converter/commit/cb673e9d6ee0840b12512979d0fb6711065960df))

## [4.9.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.9.0) - 2026-10-06

### Features

- Lay out dashed pens in logical space under unequal axis scales ([daa5d96](https://github.com/ChristopherVR/emf-converter/commit/daa5d9669b5871342f0f4be533a8ef034a11c884))

## [4.8.21](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.21) - 2026-10-06

### Bug Fixes

- Match native GetPath for odd-width inside-frame shapes at fractional scales ([d87fc6a](https://github.com/ChristopherVR/emf-converter/commit/d87fc6a1c1a9c6d1b07a542a4a7b825697308381))
- Match native GetPath for clockwise inside-frame shapes at fractional scales ([14315cd](https://github.com/ChristopherVR/emf-converter/commit/14315cd751ecc320df10c7ff13993d8f00f46d9a))
- Reproduce native paths for inside-frame pens as wide as the shape ([0edcef9](https://github.com/ChristopherVR/emf-converter/commit/0edcef908ee4780310008288925e2d0107291efa))

### Testing

- Require exact fractional RoundRect translation paths; refresh stale docs ([fc7faad](https://github.com/ChristopherVR/emf-converter/commit/fc7faad863584a1e4c15277da755e3c24fcedbed))

## [4.8.20](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.20) - 2026-10-05

### Build & CI

- **deps:** Update all dependencies to latest ([89fff20](https://github.com/ChristopherVR/emf-converter/commit/89fff20471d14eb438f1adc98197600a93365b57))

## [4.8.19](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.19) - 2026-10-04

### Bug Fixes

- Scale bitmaps in embedded EMF once under EmfPlusDrawImagePoints ([a065717](https://github.com/ChristopherVR/emf-converter/commit/a065717916aa2a3cc9aa3a42c6f3c8571e5b98b3))

## [4.8.18](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.18) - 2026-10-03

### Bug Fixes

- Improve native sampling and font vector parity ([1a5029d](https://github.com/ChristopherVR/emf-converter/commit/1a5029d3b5150a2877e34150337e0ec6833bdf45))

### Documentation

- Record three further native parity rounds ([6072979](https://github.com/ChristopherVR/emf-converter/commit/60729792c0b8f04001a1315abd0274a9b45550c1))

## [4.8.17](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.17) - 2026-10-03

### Bug Fixes

- Close native bicubic kernel coefficient rounding ([2b90a4b](https://github.com/ChristopherVR/emf-converter/commit/2b90a4bd2d3a5fcabcbfbe1e80f4d50ed698eb8c))

### Testing

- Isolate diagonal hinting across gdiplus rendering modes ([2d6e906](https://github.com/ChristopherVR/emf-converter/commit/2d6e906972b420aedc0171f2a3e8b26a9a700d2b))
- Measure native filtered halftone kernel responses ([da471e4](https://github.com/ChristopherVR/emf-converter/commit/da471e49a3498466899091937e9f2750f30e7651))

## [4.8.16](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.16) - 2026-10-03

### Bug Fixes

- Preserve parent clips for svg image exclusions ([1f628dd](https://github.com/ChristopherVR/emf-converter/commit/1f628dd178fb41281896c22b70881c918ef73ea3))

## [4.8.15](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.15) - 2026-10-03

### Bug Fixes

- Match native axis-aligned bicubic sampling arithmetic ([a449068](https://github.com/ChristopherVR/emf-converter/commit/a4490686bc781bc8110f997cd024d725695c9ed2))

### Testing

- Isolate native halftone selection and fractional roundrect ties ([87deda9](https://github.com/ChristopherVR/emf-converter/commit/87deda962c061cbf513a681e9a6cb3e1bf2ab9fb))
- Isolate spatial halftone branch selection ([2385369](https://github.com/ChristopherVR/emf-converter/commit/238536913f320a00912b0956185911164f8b242e))

## [4.8.14](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.14) - 2026-10-03

### Bug Fixes

- Tighten red-eye correction and clockwise RoundRect geometry ([c24bec5](https://github.com/ChristopherVR/emf-converter/commit/c24bec535c102f86c606b2e3d4f78d3d01501129))

## [4.8.13](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.13) - 2026-10-03

### Bug Fixes

- **emf+:** Preserve collapsed vertical gradient focus lines ([b47309d](https://github.com/ChristopherVR/emf-converter/commit/b47309dd59b35874b0f61e04d9d6f1f266b54715))

## [4.8.12](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.12) - 2026-10-03

### Bug Fixes

- Validate flattened-path extent and ClearType sample origins ([73d4b21](https://github.com/ChristopherVR/emf-converter/commit/73d4b21e117a461621b9b6d494252939d3d5204b))

## [4.8.11](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.11) - 2026-10-03

### Testing

- Keep full native pen sweep within CI timeout ([4ad0f5c](https://github.com/ChristopherVR/emf-converter/commit/4ad0f5c5df1aa40545f4e219a8ae2cdccac9b021))

## [4.8.10](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.10) - 2026-10-03

### Bug Fixes

- Tighten native GDI and GDI+ rendering parity ([1e2a4c1](https://github.com/ChristopherVR/emf-converter/commit/1e2a4c1f88eb72bc1f70ada15f5e674a9e92c0b2))
- **emf+:** Round grayscale vertical origins to quarter pixels ([e9c9798](https://github.com/ChristopherVR/emf-converter/commit/e9c97989e610b933a73d91cd8a2daa245377d336))

## [4.8.9](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.9) - 2026-10-02

### Bug Fixes

- **emf:** Apply the full GDI map-mode rules to window/viewport extents ([3f0817a](https://github.com/ChristopherVR/emf-converter/commit/3f0817ad6533e7d0335a8e93a469053a8ad41f75))
- **emf+:** Accept single-leaf regions so SetClipRegion replaces the clip ([a57c7fe](https://github.com/ChristopherVR/emf-converter/commit/a57c7fe36d2dd525ba397319f79fd1fd01e07401))
- **emf+:** Draw DrawDriverString glyphs at their own positions ([63c467e](https://github.com/ChristopherVR/emf-converter/commit/63c467ef1b195c07c9939b48f4dca3b9edc3b72b))

## [4.8.8](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.8) - 2026-10-02

### Bug Fixes

- **gdi:** Preserve mapping state, inclusive bounds and full arcs ([5a5df70](https://github.com/ChristopherVR/emf-converter/commit/5a5df709b256803e66199293033fb47d27c3a787))

## [4.8.7](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.7) - 2026-10-02

### Bug Fixes

- **halftone:** Integer 13-bit enlargement weights and mirrored-axis order make all 96 mixed-axis captures exact ([646ea9e](https://github.com/ChristopherVR/emf-converter/commit/646ea9eafae094ba88660a0a719df3ba1b6803ae))
- **halftone:** Refit the enlargement kernel table on about 410 native size pairs ([559b184](https://github.com/ChristopherVR/emf-converter/commit/559b1841c5aab6ab87e808fab93e6dbda230a973))

### Other

- Merge exact mixed-axis enlargement weights (96/96 native groups) ([dd1815f](https://github.com/ChristopherVR/emf-converter/commit/dd1815f0514458e1d9704542921e1dbdb197dfac))

## [4.8.6](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.6) - 2026-10-02

### Bug Fixes

- **effects:** Refine black-box GDI+ red-eye model (sector means, carry, spread levels) ([4a1da3e](https://github.com/ChristopherVR/emf-converter/commit/4a1da3ed1015207d12e6923257527a27121193d5))

### Other

- Merge refined clean-room red-eye model ([73d7aa9](https://github.com/ChristopherVR/emf-converter/commit/73d7aa997a17e378cc1124f570899f4447f0ef71))

## [4.8.5](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.5) - 2026-10-02

### Bug Fixes

- **gdi:** Reproduce Windows' arc angle, polygon trigonometry and Bezier controls ([f0f069d](https://github.com/ChristopherVR/emf-converter/commit/f0f069d85cb154212881ca43646dadea20eb411a))
- **gdi:** Inside-frame pens pull the box in by the per-axis pen width, in EMF as well as WMF ([1d1267f](https://github.com/ChristopherVR/emf-converter/commit/1d1267faa286be8d5499de4c2eb9e1179a2d6aa5))
- **wmf:** Scale inside-frame RoundRect corners from unrounded extents, half-FIX Ellipse and RoundRect edges ([e4d7ab8](https://github.com/ChristopherVR/emf-converter/commit/e4d7ab8593fe177508a585bc62ce41ae5c1884ca))
- **gdi:** AngleArc follows the polygon trigonometry and the sub-90-degree single Bezier ([913fc9d](https://github.com/ChristopherVR/emf-converter/commit/913fc9d08e3ff652c0b58c5710e42a7adaeb0c48))

### Other

- Merge arc geometry and inside-frame pen rules ([ca22852](https://github.com/ChristopherVR/emf-converter/commit/ca22852f6987219e8fdf52dfbc85be37716cf257))

## [4.8.4](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.4) - 2026-10-02

### Bug Fixes

- **emf-plus:** Form blur kernel weights in truncating float32 arithmetic so blur is exact ([da91506](https://github.com/ChristopherVR/emf-converter/commit/da915066be73631b095496a72db94617469d61ce))

### Other

- Merge pixel-exact float32 blur kernel ([145c8cd](https://github.com/ChristopherVR/emf-converter/commit/145c8cd3813fcbd22cf494f834ade65b3e0f1f34))

## [4.8.3](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.3) - 2026-10-02

### Bug Fixes

- **emf-plus:** Match GDI+ rotated high-quality DrawImage edges and sub-rectangle taps ([b6fd312](https://github.com/ChristopherVR/emf-converter/commit/b6fd31292947a85063fa1911e5320509c8389dcd))
- **gdi:** Floor the turned u' at 0 so strongly tinted blues compress like Windows ([b281d0b](https://github.com/ChristopherVR/emf-converter/commit/b281d0b7d6aebb15185bd95eabd4ee3c1fe1dcb7))
- **gdi:** Exact BT.709 matrix and unclamped illuminant output for the HALFTONE chroma stage ([eb94b59](https://github.com/ChristopherVR/emf-converter/commit/eb94b59ea5cb0b07ea946b9ea041630717499b16))
- **gdi:** Reduce both axes like Windows' HALFTONE (rows rounded, columns unrounded, then sharpen) ([fc70ff7](https://github.com/ChristopherVR/emf-converter/commit/fc70ff70a7d22ff96fec97a220a63ab5b9841046))
- **gdi:** Sharpen the last row against a dithered replica row for mixed-axis adjusted stretches ([a726569](https://github.com/ChristopherVR/emf-converter/commit/a7265698318a818d907d659703a5f778782f485a))

## [4.8.2](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.2) - 2026-10-02

### Bug Fixes

- **gdi-raster:** Measure dashes on curves in whole pixels like WidenPath ([e13a5c0](https://github.com/ChristopherVR/emf-converter/commit/e13a5c064e605953554aa2fd55df484bbebbd975))

### Testing

- Give the SVG shadow comparison more time for the slower blur path ([7ca0ece](https://github.com/ChristopherVR/emf-converter/commit/7ca0eced9272377806ed0c7e41f53b8d7cafc163))

## [4.8.1](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.1) - 2026-10-02

### Bug Fixes

- **emf-plus:** Form Levels tables in truncating float32 arithmetic ([edaeac9](https://github.com/ChristopherVR/emf-converter/commit/edaeac904206f799f3e14e242e87ac8aa3e5f0b9))
- **emf-plus:** Reproduce Hue/Saturation/Lightness in native all-integer HSL ([e5618e0](https://github.com/ChristopherVR/emf-converter/commit/e5618e00428852b0f886a7af31cbffe140d691a9))
- **emf-plus:** Rebuild Tint in native integer luma-preserving arithmetic ([9a6b8eb](https://github.com/ChristopherVR/emf-converter/commit/9a6b8eb322691017913817972d095c93bbb4bd59))
- **emf-plus:** Reproduce Tint exactly (amount scales the largest channel by w/256) ([36cc4dd](https://github.com/ChristopherVR/emf-converter/commit/36cc4dd25626a746ebe7753ccfd5173f67440f77))
- **emf-plus:** Mirror only the x origin of a high-quality axis-aligned DrawImage ([2860e56](https://github.com/ChristopherVR/emf-converter/commit/2860e56740bd3521521fc8ba6ed6764b191f684f))
- **emf-plus:** Map a nested metafile onto its destination first-pixel to last-pixel ([c6b5da9](https://github.com/ChristopherVR/emf-converter/commit/c6b5da95dc9d61da8c66e68f522f14bfd387f6d3))

### Other

- Merge exact Levels, HSL, Tint, nested-metafile and DrawImage origin fixes ([f97efa9](https://github.com/ChristopherVR/emf-converter/commit/f97efa9001b8b04ff6b52eed9d6f76c506720411))

### Documentation

- Record the rotated high-quality DrawImage edge measurements ([f7ae595](https://github.com/ChristopherVR/emf-converter/commit/f7ae595009452291774ffc5a2bc193209df35acc))

## [4.8.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.8.0) - 2026-10-02

### Features

- Reproduce the halftone dither origin for mirrored, mixed-axis, PlgBlt and rotated blits ([162e274](https://github.com/ChristopherVR/emf-converter/commit/162e2741ce328c8b521b45b0d01c44ef05677692))
- Model GDI+ red-eye correction as polar sectors around a redness centre ([02bf61f](https://github.com/ChristopherVR/emf-converter/commit/02bf61f10a82a87ea7fc52030fc31a974cd88348))

### Bug Fixes

- Read palette levels unrounded in the colorfulness/tint stage and round before the curves ([00961d1](https://github.com/ChristopherVR/emf-converter/commit/00961d1120cab3a8c8f4e813a909cde70e382dc4))
- Apply the GDI+ blur centre weight as two rounded halves, pick edge modes by reduced size, leave a lone-sample tail pixel ([9b3f2ec](https://github.com/ChristopherVR/emf-converter/commit/9b3f2ec2e9f426b5dc306961be09abd9ff220505))
- Enlarge only an expanded blur's own reduced samples, treat the buffer ends as transparent and continue a lone sample ([06a5427](https://github.com/ChristopherVR/emf-converter/commit/06a5427d735eab6c57f265f7b95c030408b50f24))
- Close the single-row and exact-tie HALFTONE mixed-axis groups ([9a7c6b3](https://github.com/ChristopherVR/emf-converter/commit/9a7c6b3f1cf85f12c56c141232e4996739576338))
- Reduce HALFTONE mixed-axis footprints with 13-bit cumulative shares ([c8b4cd1](https://github.com/ChristopherVR/emf-converter/commit/c8b4cd1be16af54baf5bcc1b48364ebfcbec2613))
- Red-eye working radius from the left/top edge and flat weight for pure reds ([412ff84](https://github.com/ChristopherVR/emf-converter/commit/412ff846a17bfadfe42545de7ded81c30ea4f050))
- Replace the flat-pen sector table with a closed perpendicular rule ([401037c](https://github.com/ChristopherVR/emf-converter/commit/401037c9767054ff1926f0d187ed2a7ca81701d7))
- Reproduce native arc geometry and scaled WMF arcs and rounded rectangles ([d985456](https://github.com/ChristopherVR/emf-converter/commit/d985456e420c4ba2f84ad18104435296583ea2ca))
- Scale WMF RoundRect corners onto the drawn box for wide and null pens ([c40a0d2](https://github.com/ChristopherVR/emf-converter/commit/c40a0d2b12da40aa7534f87532bf0ec4a3857795))
- Widen curves with per-segment curve rules and fix flat round join arcs ([50e5274](https://github.com/ChristopherVR/emf-converter/commit/50e5274036501d5eedc40f69e699ea1775fd7fb5))

### Other

- Merge colour adjustment rounding and dither-origin work ([50ba20a](https://github.com/ChristopherVR/emf-converter/commit/50ba20a6ec47622145bb062ff1cc262a4a6adc13))
- Merge blur centre-weight, edge-mode and expanded-blur fixes ([9bb12be](https://github.com/ChristopherVR/emf-converter/commit/9bb12be5f918b30a6964c76698acccd12bcddad3))
- Merge exact mixed-axis reduction shares and single-row collapse ([96769d2](https://github.com/ChristopherVR/emf-converter/commit/96769d21b2397999c9a7a6988b1233caaec51cb3))
- Merge clean-room black-box red-eye model ([5d9523c](https://github.com/ChristopherVR/emf-converter/commit/5d9523c02f049dccf3a4ad5b4fb6c9b113645a5f))
- Merge flat-pen rule, arc geometry, RoundRect corners and curve widening ([cea4520](https://github.com/ChristopherVR/emf-converter/commit/cea45206700f16c8e3333b2360705fb76c4af713))

## [4.7.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.7.0) - 2026-10-02

### Features

- **gdi:** Replace the halftone despeckle heuristic with the measured two-by-two checker algorithm ([8d8e774](https://github.com/ChristopherVR/emf-converter/commit/8d8e774324a1ec762d670348bd14e624f5f6a432))

## [4.6.10](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.6.10) - 2026-10-01

### Documentation

- Refresh outstanding work for the Blend, colour adjustment and halftone results ([1701b7c](https://github.com/ChristopherVR/emf-converter/commit/1701b7c45f124e428b145bd8dce79e1be75eebfe))

## [4.6.9](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.6.9) - 2026-10-01

### Bug Fixes

- Reproduce native large-radius blur axis by axis ([cd15995](https://github.com/ChristopherVR/emf-converter/commit/cd1599514b7c4e2f59420204dc73af645e78f528))

### Testing

- Allow the expanded blur sweep more time for the per-axis blur pipeline ([be24dc8](https://github.com/ChristopherVR/emf-converter/commit/be24dc88bfcd3ec88745c710c8b70158a8aadb7c))

## [4.6.8](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.6.8) - 2026-10-01

### Features

- Model HALFTONE mixed-axis enlargement and reduction weights from native captures ([d0fc972](https://github.com/ChristopherVR/emf-converter/commit/d0fc9727faaa1a89db3194fc31c928d9e0c03d62))

### Other

- Merge mixed-axis area-resample model with odd-size despeckle edges ([cf89cc6](https://github.com/ChristopherVR/emf-converter/commit/cf89cc68ceb5ede90cf6d2aabdc1c24ec1ca15b7))

## [4.6.7](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.6.7) - 2026-10-01

### Bug Fixes

- Match native PS_INSIDEFRAME widening for fractional widths and filled curves ([16cf4ce](https://github.com/ChristopherVR/emf-converter/commit/16cf4ce5a1ac31e9d92e3b922a34df4aa3b44040))

### Other

- Merge WMF inside-frame work with the flat-pen sector table ([408d732](https://github.com/ChristopherVR/emf-converter/commit/408d73229ff4dad956c23fec0f955d89dcb7fa48))

## [4.6.6](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.6.6) - 2026-10-01

### Bug Fixes

- Fit flattened-pen perpendicular rounding per pen edge against native WidenPath ([8dc0b35](https://github.com/ChristopherVR/emf-converter/commit/8dc0b3587667d902271e58bc8287a9280c981188))

## [4.6.5](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.6.5) - 2026-10-01

### Bug Fixes

- Reproduce native odd-size edge handling in the halftone despeckle ([dc34961](https://github.com/ChristopherVR/emf-converter/commit/dc349611d5b89b1a692c1cd36e07b0770ab73fca))

## [4.6.4](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.6.4) - 2026-10-01

### Bug Fixes

- Form Blend knots in truncating float32 arithmetic ([e33574a](https://github.com/ChristopherVR/emf-converter/commit/e33574a550ed8e7e833e0c6283e6e4ed0e8940d4))

## [4.6.3](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.6.3) - 2026-10-01

### Bug Fixes

- Interpolate large-radius blur from the unrounded filtered buffer ([ba16e7c](https://github.com/ChristopherVR/emf-converter/commit/ba16e7c66aad2da317b84259fec7aadf7401c345))

## [4.6.2](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.6.2) - 2026-10-01

### Documentation

- Record measured red-eye behaviour ([0e0ff50](https://github.com/ChristopherVR/emf-converter/commit/0e0ff509334016577451010a0315782ad4620824))

## [4.6.1](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.6.1) - 2026-10-01

### Documentation

- Describe odd-size halftone enlargement edge ([1f87000](https://github.com/ChristopherVR/emf-converter/commit/1f870004c390dc042b083bcd1394ffadcf7249aa))

## [4.6.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.6.0) - 2026-10-01

### Features

- Reproduce Windows' halftone colour adjustment and its ordered dither ([552d504](https://github.com/ChristopherVR/emf-converter/commit/552d50429988a8eb8a79811512be34d84f56255b))

## [4.5.2](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.5.2) - 2026-10-01

### Build & CI

- **deps:** Bump actions/upload-artifact (#18) ([aeada3f](https://github.com/ChristopherVR/emf-converter/commit/aeada3f3238daf917a8c367008d0c5ccdea4303b))

## [4.5.1](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.5.1) - 2026-10-01

### Bug Fixes

- Round the mixed-axis halftone interpolation kernel like Windows ([2ce6209](https://github.com/ChristopherVR/emf-converter/commit/2ce62093fa0dc496737ec377205d87289f66bc34))

## [4.5.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.5.0) - 2026-10-01

### Features

- Bit-exact libjpeg-compatible JPEG decoder ([205581f](https://github.com/ChristopherVR/emf-converter/commit/205581f00bd62c9bc47f8eb64c0eb8d810e7de2a))

## [4.4.16](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.4.16) - 2026-10-01

### Bug Fixes

- Extend native mixed halftone pipeline to all enlargement ratios ([2419ea9](https://github.com/ChristopherVR/emf-converter/commit/2419ea99328fce4071ba7ce5f93e4cd40451cb15))

## [4.4.15](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.4.15) - 2026-10-01

### Bug Fixes

- Match native mixed-axis halftone stretch for 2x enlargement with reduction ([e830ed5](https://github.com/ChristopherVR/emf-converter/commit/e830ed58e667064dfde4e0cea9af209376dbc8cc))

### Documentation

- Describe native mixed-axis halftone coverage ([dbf33df](https://github.com/ChristopherVR/emf-converter/commit/dbf33dffa2a71880c62419c8a1172f41ee52adbb))

## [4.4.14](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.4.14) - 2026-10-01

### Bug Fixes

- Match native miter limits and pen arc endpoint selection ([2947640](https://github.com/ChristopherVR/emf-converter/commit/29476404370dd37cced789a588bf0f81b34d8da8))

## [4.4.13](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.4.13) - 2026-09-30

### Bug Fixes

- Reproduce native expanded blur cropping and reduction ([0cb49f9](https://github.com/ChristopherVR/emf-converter/commit/0cb49f981db18e9e9b516ed28118bff50223b4c1))

## [4.4.12](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.4.12) - 2026-09-30

### Testing

- Bound native Blend rounding across 4352 gradient ramps ([445cd06](https://github.com/ChristopherVR/emf-converter/commit/445cd06562e84e019aa26d4df71f57b8dbaf8099))

## [4.4.11](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.4.11) - 2026-09-30

### Bug Fixes

- Quantize native Tint hues and preserve probe alpha ([f2c883e](https://github.com/ChristopherVR/emf-converter/commit/f2c883e19d229d37944038d623f46c474ec3191d))

## [4.4.10](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.4.10) - 2026-09-30

### Bug Fixes

- Match native HSL hue quantization and rotation ([50309ac](https://github.com/ChristopherVR/emf-converter/commit/50309ac9ac28655b08ffbd7519c662bae5500b4d))

## [4.4.9](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.4.9) - 2026-09-30

### Bug Fixes

- Decode RGB JPEG TIFF and reconstruct subsampled chroma ([e590d86](https://github.com/ChristopherVR/emf-converter/commit/e590d86b1bd0bd7c7b9e69bece260a5edf3e3ef8))

## [4.4.8](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.4.8) - 2026-09-30

### Bug Fixes

- Reproduce native large-radius blur reduction ([bba5364](https://github.com/ChristopherVR/emf-converter/commit/bba536410431816ff0b45445100af0c89ecb14d2))

## [4.4.7](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.4.7) - 2026-09-30

### Bug Fixes

- Match native widened ellipse outlines and inner triangles ([89fe52f](https://github.com/ChristopherVR/emf-converter/commit/89fe52f204a3a76bfda3ac3a76e089818ee6bd02))
- Retain fractional inside-frame widths on WMF curves ([dc5a3b1](https://github.com/ChristopherVR/emf-converter/commit/dc5a3b1b4fc67eff8050e72822987b3f2220e2cb))

## [4.4.6](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.4.6) - 2026-09-30

### Bug Fixes

- Decode explicitly one-dimensional Group 3 TIFF strips ([c1111cc](https://github.com/ChristopherVR/emf-converter/commit/c1111cc9a65d4e186b3e1a4a4b20fa6b4da2ca7d))

## [4.4.5](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.4.5) - 2026-09-30

### Testing

- Capture native colour and wide-path baselines with provenance ([e021c10](https://github.com/ChristopherVR/emf-converter/commit/e021c1017f450e26326635634c6a55c18b44b809))

## [4.4.4](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.4.4) - 2026-09-30

### Bug Fixes

- Match native RoundRect paths and image effect filtering ([3a917e4](https://github.com/ChristopherVR/emf-converter/commit/3a917e498f7448e1dba5a1b3e2049cde34a9e83d))

### Testing

- Avoid redundant Levels LUT computation ([96d8bec](https://github.com/ChristopherVR/emf-converter/commit/96d8bece4e71fe3c90a5069912447d1af12d3390))

## [4.4.3](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.4.3) - 2026-09-30

### Bug Fixes

- Match standalone GDI channel curves and compatible rounding ([85f0712](https://github.com/ChristopherVR/emf-converter/commit/85f07127a1f1868ee7246c2980163727b115e2e2))

## [4.4.2](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.4.2) - 2026-09-30

### Bug Fixes

- Match GIF canvas backgrounds and improve mixed-axis halftone ([44c3c85](https://github.com/ChristopherVR/emf-converter/commit/44c3c858b1a3fb68f93e743510aa5cbeab373989))

## [4.4.1](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.4.1) - 2026-09-30

### Bug Fixes

- Ship browser entry without optional Node imports ([69d7f8c](https://github.com/ChristopherVR/emf-converter/commit/69d7f8cc76209b6b143f0212932cddb25969b0c6))

## [4.4.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.4.0) - 2026-09-30

### Features

- Support affine pens, ANSI encodings and image effects ([ad655d0](https://github.com/ChristopherVR/emf-converter/commit/ad655d0993e8cc91d36d0a512145f2f87eb35945))
- Add native colour curves and levels effects, fix WMF RTL ([2000fc1](https://github.com/ChristopherVR/emf-converter/commit/2000fc17f2e6ad9c66a4c284dc3b40b70d4444d4))
- Close image decoding, deferred effects and anchor cap gaps ([0f7f8ed](https://github.com/ChristopherVR/emf-converter/commit/0f7f8ed92045d5d9810f419586850904badfe442))

## [4.3.5](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.3.5) - 2026-09-28

### Bug Fixes

- Match GDI+ image effect algorithms to Windows output ([df5fe59](https://github.com/ChristopherVR/emf-converter/commit/df5fe5994d279a79f976b46c3073742b10738e96))
- Record Windows effect fixtures with the right EmfType and update outstanding work ([6d716d6](https://github.com/ChristopherVR/emf-converter/commit/6d716d688af4874d1f1e70afd1a2420d8dee2092))

### Testing

- Add Windows GDI+ image effect fixtures ([b3c0890](https://github.com/ChristopherVR/emf-converter/commit/b3c0890e17f8d6b40ebf5f5d72013745474ad661))

## [4.3.4](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.3.4) - 2026-09-28

### Documentation

- List outstanding work ([e941743](https://github.com/ChristopherVR/emf-converter/commit/e941743b3583649ea7c9bb7ecc541a658530814a))

## [4.3.3](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.3.3) - 2026-09-28

### Bug Fixes

- Match Windows' HALFTONE resampling and refit the colour adjustment ([2780238](https://github.com/ChristopherVR/emf-converter/commit/27802382e053dea0d842cab562ab0e9e983b7c1c))
- Lay out EMF+ pen-transform dashes in world space and draw ArrowAnchor ([ce21dde](https://github.com/ChristopherVR/emf-converter/commit/ce21dde749b7ff67f4f6906bc9ceb4fabd5c2a6e))

### Testing

- Add Windows HALFTONE and pen transform fixtures ([bd7cff2](https://github.com/ChristopherVR/emf-converter/commit/bd7cff266f31c211044b3d1a937bf2a0fd5304cd))

## [4.3.2](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.3.2) - 2026-09-28

### Bug Fixes

- Build GDI paths the way Windows' GetPath reports them ([97d0381](https://github.com/ChristopherVR/emf-converter/commit/97d0381feb29112978f31fae8515a6a450042568))
- Mirror META_SETDIBTODEV's destination under LAYOUT_RTL ([a9bdd2b](https://github.com/ChristopherVR/emf-converter/commit/a9bdd2b576b181dbf7823d2b07e08b1d499529d0))

### Testing

- Check GDI path geometry against Wine's Windows-verified data ([1a0eb09](https://github.com/ChristopherVR/emf-converter/commit/1a0eb09908a36f345160bb7ee3eaaae0fc0550f3))

## [4.3.1](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.3.1) - 2026-09-28

### Build & CI

- Generate Windows reference fixtures on a Windows runner ([6301668](https://github.com/ChristopherVR/emf-converter/commit/6301668b13b4527598ce7081b1e85176b67407bb))

## [4.3.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.3.0) - 2026-09-28

### Features

- Apply EMR_SETCOLORADJUSTMENT to HALFTONE blits and box-filter HALFTONE ([9a59d5d](https://github.com/ChristopherVR/emf-converter/commit/9a59d5dd8a5ddfff9d5eb8014a5810630801a05c))

## [4.2.1](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.2.1) - 2026-09-28

### Bug Fixes

- Draw custom caps of gradient and texture EMF+ pens ([c8d0f20](https://github.com/ChristopherVR/emf-converter/commit/c8d0f20fad9688af1ebae7ed2905ded429c89cec))
- Remove leftover debug offsets from the brush mask transform ([c6653d1](https://github.com/ChristopherVR/emf-converter/commit/c6653d1a1b2f73991d93186e338f1fe1d041520b))
- Apply EMF+ image effects to the source rectangle and grow expanded blurs ([381826d](https://github.com/ChristopherVR/emf-converter/commit/381826d04d0e0f3e12ded67b834b5e21c7d8733a))

### Build & CI

- Type-check the docs site ([b9c298e](https://github.com/ChristopherVR/emf-converter/commit/b9c298e89a15d4faef9480cdbc38db3d791d3556))

## [4.2.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.2.0) - 2026-09-28

### Features

- Support nonuniform and skewed EMF+ pen transforms ([0ae5c6b](https://github.com/ChristopherVR/emf-converter/commit/0ae5c6b2e1ac09bd5f0803a32b04a5c2728d3d8e))
- Apply EMF+ image effects to DrawImage ([2f21d93](https://github.com/ChristopherVR/emf-converter/commit/2f21d93d7ad43fb7266c408a14ef546f050ca3f2))

### Bug Fixes

- Skip the EMF fallback of dual-mode EMF+ files and keep the bounds origin under a mapping mode ([f5d892a](https://github.com/ChristopherVR/emf-converter/commit/f5d892ac39059f3914d5ae5cecc41c61c781b7ea))

### Documentation

- Replace the demo page with a VitePress site ([3e6506f](https://github.com/ChristopherVR/emf-converter/commit/3e6506fd8497686d4ba052333e7ed41769e7f868))
- Sync the pen transform limitation with the README ([faf9bc4](https://github.com/ChristopherVR/emf-converter/commit/faf9bc4c456b570135979a90315c94a9d7c7fecf))

## [4.1.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.1.0) - 2026-09-27

### Features

- Support additional EMF text records and pen transforms ([450b685](https://github.com/ChristopherVR/emf-converter/commit/450b68506b621e8c12c863bdaa83922de9300590))

## [3.5.1](https://github.com/ChristopherVR/emf-converter/releases/tag/v3.5.1) - 2026-09-25

### Documentation

- Keep only real limitations in the README and demo ([235f437](https://github.com/ChristopherVR/emf-converter/commit/235f43744f18ecda4e9221a7184f9e5e6db7ff90))

## [3.5.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v3.5.0) - 2026-09-25

### Features

- Exact SVG raster ops with no canvas, exact GDI text via a TrueType engine ([63c2f13](https://github.com/ChristopherVR/emf-converter/commit/63c2f135b3d7e17b9ca5992edb0a528b00359f01))
- GDI-exact rasterizer and GDI+ gradient/image/texture fidelity ([713c2dc](https://github.com/ChristopherVR/emf-converter/commit/713c2dc87aca6a45d14eaabd47a1369cae390b8f))
- GDI ClearType interpreter rules and compatible-width fitting ([709928d](https://github.com/ChristopherVR/emf-converter/commit/709928d5e0148bb84aa31e6f756ac048120c8418))
- GdiTextCoverage, the GDI engine's per-run glyph coverage mask for brush-filled text ([6c46f93](https://github.com/ChristopherVR/emf-converter/commit/6c46f93adf4350ebc0f920742ecc933b5f3e5289))
- Raster (.fon) fonts drawn from their bitmaps, MS Shell Dlg size snapping ([26030f3](https://github.com/ChristopherVR/emf-converter/commit/26030f30333e282e341fe409caffea67ee53bf78))
- LoadSystemFonts() reads installed font files for the fonts option ([8d7db7f](https://github.com/ChristopherVR/emf-converter/commit/8d7db7ff02a1f059b5ddc1f783cc7b078de90c06))
- Rotated text uses GDI's rounded font matrix and rotated cell metrics ([e4db299](https://github.com/ChristopherVR/emf-converter/commit/e4db299bbe80ba7ed576dcd429e571531493f5a7))
- GDI+ DrawString spacing, gasp and Clear; text blends over transparent pixels ([541704c](https://github.com/ChristopherVR/emf-converter/commit/541704c439dc64a789aaa38f688ed4a38b36722c))
- EMF+ DrawString with texture/gradient brushes through the GDI font engine's glyph coverage ([644e380](https://github.com/ChristopherVR/emf-converter/commit/644e3806394b80169bb54fed959e79a4cd0ab03d))
- EMF+ follows the recorded SmoothingMode with GDI+'s own fill rasteriser and pen widener ([96da7dc](https://github.com/ChristopherVR/emf-converter/commit/96da7dcf3a99224c48cae4d6ed6fc87c9ddbca7b))
- GDI+'s exact clip-region pixels and antialiasing blend arithmetic ([b00fcec](https://github.com/ChristopherVR/emf-converter/commit/b00fcec9d5e8219130728d98ea06cb10e5b44b91))
- **gdi-raster:** GDI-exact wide pens, caps, joins and geometric dashes ([acac1ee](https://github.com/ChristopherVR/emf-converter/commit/acac1ee0082f26091a30c9b769d5ae44e6e71d66))
- PNG output reproduces Windows rasterisation by default ([667fbbd](https://github.com/ChristopherVR/emf-converter/commit/667fbbdd3c07117a91dfca62062349d6584217e2))
- **wmf:** Play WMF records through the shared GDI machinery ([d1ec6c0](https://github.com/ChristopherVR/emf-converter/commit/d1ec6c0dc237f005b3d288f51fb2656b2b7b1631))
- **wmf:** Exact mapping modes, clipping, regions and bitmap records ([3cdae11](https://github.com/ChristopherVR/emf-converter/commit/3cdae119fe02e171be670bafe044f3e55f7a7ee8))
- **wmf:** Palettes, pixels, flood fill, text spacing, layout and embedded EMF ([0a1c6f3](https://github.com/ChristopherVR/emf-converter/commit/0a1c6f38fdde6a407526d81ced09e7eec36f2fa1))
- **emf-plus:** Curves, regions, containers, hatch brushes, compositing and terminal-server records ([030d3ac](https://github.com/ChristopherVR/emf-converter/commit/030d3ac6ab53ee801b7ea5e6d28d769b7895e5d3))
- **emf-plus:** Custom line caps and text contrast ([6250f47](https://github.com/ChristopherVR/emf-converter/commit/6250f4753fb3ca60909cccbcdf8f298040f1c12d))
- **emf-plus:** Relative and compressed DrawImagePoints destination points ([3ae1063](https://github.com/ChristopherVR/emf-converter/commit/3ae106346f24b367e259144a5a04ff576340cda0))
- **emf-plus:** GDI+'s nominal-width line and Bezier flattener ([46159c9](https://github.com/ChristopherVR/emf-converter/commit/46159c93b4929c872b5a2983bacbcedb9d33eb7f))
- **emf:** Palettes, AlphaBlend, TransparentBlt, MaskBlt, PlgBlt and SetDIBitsToDevice records ([5aec1b4](https://github.com/ChristopherVR/emf-converter/commit/5aec1b4949e34b5038ba120cc014747b27c42306))
- **emf:** AngleArc, PolyDraw, PolyPolyline16, path flatten/widen/abort, region records and flood fill ([ab3390c](https://github.com/ChristopherVR/emf-converter/commit/ab3390c3de170d32ede083a6c1febf376e61b2d4))
- **emf:** Exact GradientFill, emf-records parity cases and unit tests ([cff1e81](https://github.com/ChristopherVR/emf-converter/commit/cff1e817019d860d901e50eb9be9f6d4ecf82e3a))

### Bug Fixes

- GDI+ ClearTypeGridFit text uses natural ClearType widths ([2e653b4](https://github.com/ChristopherVR/emf-converter/commit/2e653b4e672faeed7be3398d33c626214b73d4b4))
- GDI+'s 10-bit linear light for gamma-corrected gradients and translucent knot ties ([15f3a85](https://github.com/ChristopherVR/emf-converter/commit/15f3a85c88487d99db77640fe305e797a15420de))
- Keep Canvas-drawn EMF+ text and SVG output off the antialiasing half-pixel shift ([9d4f0a4](https://github.com/ChristopherVR/emf-converter/commit/9d4f0a4985ef95cf50a7785620b7b9150ffc30b5))
- **gdi-raster:** Exact partial arcs, ArcTo current position and rotated-blit ties ([c4cf84e](https://github.com/ChristopherVR/emf-converter/commit/c4cf84e67c84bb02e0be36827625789aa2b6a427))
- **wmf:** Cosmetic pens by device pixel at any dpiScale; deterministic WMF fixtures ([a299fa3](https://github.com/ChristopherVR/emf-converter/commit/a299fa31167c9fcc163b6c3c1a0d8ba13e0ae967))
- **emf-plus:** Exact NearestNeighbor DrawImage on sheared and sub-rectangle draws ([9017d4f](https://github.com/ChristopherVR/emf-converter/commit/9017d4f39850bcc8ea2947691b1bfc37269aba12))

### Refactor

- **wmf:** Drop leftover re-exports ([0ff49d7](https://github.com/ChristopherVR/emf-converter/commit/0ff49d7f94b786645c0abe2ff51408f7462d322e))

### Documentation

- Document v4 SVG/React output, Windows-exact rendering, fonts, and record coverage ([dc2f095](https://github.com/ChristopherVR/emf-converter/commit/dc2f0952641585b45cd3b59216f8a4549ff1018b))

### Testing

- Tighten EMF+ parity bounds to the GDI+-exact rasterisation and add SmoothingMode cases ([cac6668](https://github.com/ChristopherVR/emf-converter/commit/cac66681ad17d3f6bc4088390ed6b8edb4a4ec59))
- **wmf:** Parity cases for every WMF record fixture, SVG mirror and unit tests ([cc3431a](https://github.com/ChristopherVR/emf-converter/commit/cc3431a7370094c8dffe10576f0d03c61425a2ec))
- **parity:** Custom-cap antialiased bound from the committed widener (0.051%) ([9aa4830](https://github.com/ChristopherVR/emf-converter/commit/9aa48302ae5e4d91a6562a47aa6dbd5dcb41d665))

## [3.4.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v3.4.0) - 2026-09-25

### Features

- SVG output (markup, data URL, React/JSX) and exact fixes for documented limitations ([a8d3e63](https://github.com/ChristopherVR/emf-converter/commit/a8d3e63d6d2ed1727e0d9f9935abd5b6b835eec8))

## [3.3.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v3.3.0) - 2026-09-24

### Features

- Rotate bitmap blits/text under world transforms, decode compressed EMF+ textures, fix Image BitmapDataType, exact ROP2 for bracketed paths ([5a06353](https://github.com/ChristopherVR/emf-converter/commit/5a06353db6251a58ce4862668353730abd5f169b))

## [3.2.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v3.2.0) - 2026-09-24

### Features

- Exact GDI pattern-brush fills, world-transform rotation, and bitwise ROP2 ([1cf9ab3](https://github.com/ChristopherVR/emf-converter/commit/1cf9ab38d20d6bbaa223e9a758ad3095a0aa2474))

## [3.1.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v3.1.0) - 2026-09-24

### Features

- Exact ROP3 raster operations, GDI text layout and gradient wrap modes ([9ee23ea](https://github.com/ChristopherVR/emf-converter/commit/9ee23eaf0841915179d2e3a81e21a5f76d67c9ec))
- Evaluate all 256 ROP3 codes exactly against real brush patterns ([8ffa864](https://github.com/ChristopherVR/emf-converter/commit/8ffa864654fb33e8660e6147fe594dccbaf8cecb))
- Tile wrapped angled linear gradients and exact path gradients ([59d0060](https://github.com/ChristopherVR/emf-converter/commit/59d0060aba3a18c3e136d9c06f3e65032c245257))

### Bug Fixes

- Build DIB ImageData through the active canvas backend ([082737b](https://github.com/ChristopherVR/emf-converter/commit/082737b099a7fc34298eef1716c4dbec22307727))

## [3.0.2](https://github.com/ChristopherVR/emf-converter/releases/tag/v3.0.2) - 2026-09-21

### Bug Fixes

- Keep bundlers from resolving the @napi-rs/canvas fallback (#14) ([558e806](https://github.com/ChristopherVR/emf-converter/commit/558e806e660572755e0c41a7c226eeed704272ad))

## [3.0.1](https://github.com/ChristopherVR/emf-converter/releases/tag/v3.0.1) - 2026-09-17

### Chores

- **deps-dev:** Bump @types/node from 22.20.3 to 26.5.1 (#12) ([7774a4a](https://github.com/ChristopherVR/emf-converter/commit/7774a4af5eb8382822d1e84b9b5cb168cba73989))

## [3.0.0](https://github.com/ChristopherVR/emf-converter/releases/tag/v3.0.0) - 2026-09-16

### Features

- Document the convertEmfToDataUrl/convertWmfToDataUrl removal ([8773faa](https://github.com/ChristopherVR/emf-converter/commit/8773faa1155666919a44dc4a2d0953bc74c8a977))

## [2.0.4](https://github.com/ChristopherVR/emf-converter/releases/tag/v2.0.4) - 2026-09-16

### Other

- Merge EMF/WMF converters into one auto-detecting function, add optional Node.js canvas backend ([767d155](https://github.com/ChristopherVR/emf-converter/commit/767d1555bc4a3e900a770282a6dd5ecaeb9c54dc))
- Refresh demo landing page for the unified convertMetafileToDataUrl API ([05edd31](https://github.com/ChristopherVR/emf-converter/commit/05edd31f3b6aa8f47659c7c206a25709ba38d8a1))

### Chores

- Remove em dashes from source, docs, and workflow files ([8ee3852](https://github.com/ChristopherVR/emf-converter/commit/8ee3852cfce61c1055101daacd39c437f0a17e1a))
- Ignore .claude/worktrees/ ([d2fabbf](https://github.com/ChristopherVR/emf-converter/commit/d2fabbfd6e1f4bfb6ec827e5089b7dbc6f794116))

## [2.0.3](https://github.com/ChristopherVR/emf-converter/releases/tag/v2.0.3) - 2026-09-16

### Chores

- **deps-dev:** Bump vitest from 4.1.11 to 5.0.0 ([036c06a](https://github.com/ChristopherVR/emf-converter/commit/036c06ae498ff40f3fffc32cd8f9bd53c497e17b))
- **deps-dev:** Update lockfile for vitest 5.0.0 ([62dc37b](https://github.com/ChristopherVR/emf-converter/commit/62dc37b55325205927ea9c1938ee335f4d2b9f55))

## [2.0.2](https://github.com/ChristopherVR/emf-converter/releases/tag/v2.0.2) - 2026-07-27

### Bug Fixes

- **ci:** Anchor release notes to the version being released ([b242a45](https://github.com/ChristopherVR/emf-converter/commit/b242a4551646a450079a6854b6a35d7633f9c434))

## [2.0.1](https://github.com/ChristopherVR/emf-converter/releases/tag/v2.0.1) - 2026-07-27

### Other

- Map the font height through the window/viewport transform ([c6aae7d](https://github.com/ChristopherVR/emf-converter/commit/c6aae7d66ea56574edf53d7eb066afaa99d1c151))

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

### Other

- Initial commit ([e717c1b](https://github.com/ChristopherVR/emf-converter/commit/e717c1bf9e853e1a97e6363a0570fa91aeb58e8f))

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


