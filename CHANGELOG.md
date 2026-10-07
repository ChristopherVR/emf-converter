# Changelog

All notable changes to this project are documented here.
This file is generated from [Conventional Commits](https://www.conventionalcommits.org)
by [git-cliff](https://git-cliff.org); do not edit it by hand.

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


