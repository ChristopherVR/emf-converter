# Native parity review

Review date: 12 October 2026. Baseline: `465e3a6` (v4.20.0).

The portable TypeScript renderer already covers substantially more metafile behaviour than the Rust converters reviewed below. Keep it as the primary implementation. A different graphics library does not, by itself, reproduce Windows' GDI and GDI+ arithmetic.

## Measured baseline

The baseline passes 203 test files and 6,837 tests, library and documentation type checks, the package build, and the browser-package regression check.

Running `bun scripts/gdi-fixtures/report.ts` with the available Windows fixture fonts gives:

| Measurement | Baseline |
| --- | ---: |
| Exact RGB comparisons over the common device area | 638 / 870 |
| Exact RGB with complete painted-ink coverage | 634 / 870 |
| Conversion failures | 0 |
| Comparisons omitting captured reference ink | 0 |
| Comparisons with rendered ink outside the captured reference | 14 |

These are local measurements, not a universal compatibility percentage. The report composites over white, compares RGB, and aligns device coordinates; it does not independently establish alpha equality. Some captures have smaller extents than the converter output. Passing tolerance-based tests also does not mean that every pixel matches. The historical measurements in [Outstanding work](./outstanding-work.md) remain useful but describe earlier revisions and environments.

The largest visible residuals are still text. Image sampling, gradients and geometry also retain smaller differences, often one channel level. Older font references and state-dependent native behaviour require environment provenance rather than guessed arithmetic changes.

## Changes from this review

Three GPT-6.1 Sol workstreams investigated native mapping, image sampling, and open-source alternatives/texture sampling. The resulting production changes keep the browser and Node APIs and add no dependencies:

- **EMF/WMF extent scaling:** use Windows' signed 32-bit multiplication followed by truncating division. Reject the entire update when a divisor or resulting extent is zero, or when signed division overflows. Ignored/rejected EMF records do not activate mapping. All 276 captured native extent states match; the old EMF implementation missed 182. All 252 complete EMF polygon masks and 252 WMF masks match with zero tolerance.
- **EMF+ Bilinear images:** quantize the fractional source coordinate to 1/2048, preserving complementary weights; round source colours to premultiplied bytes before filtering and round the filtered bytes before returning straight RGBA. All 144 new rectangular opaque/translucent/impulse captures and 24 alpha/compositing controls match native premultiplied RGBA. Independent cropped/mirrored draws expose remaining coordinate ties rather than hiding them under a global tolerance.
- **EMF+ texture brushes:** apply the same measured weight and byte-rounding rules. All 103,680 premultiplied RGBA pixels in 240 new native controls match, covering transparency, wrapping, pixel offsets, reductions, mirrors and shear. Native straight-ARGB extraction has a separate truncation rule; copying that rule into an intermediate buffer would lose precision when Canvas premultiplies it again, so the runtime preserves the premultiplied bytes instead.

The same 870-fixture report after these changes has **646 exact common-area RGB comparisons** (up from 638) and **642 with complete RGB ink coverage** (up from 634). Twenty-eight existing comparisons improve; none have a larger mismatched-pixel count. Render failures remain zero, no reference ink is omitted, and the 14 uncaptured-extent cases remain unchanged. These improvements do **not** establish full native parity.

First-round validation: **206 test files, 7,095 tests passed**. Library/documentation type checks, package build, browser ESM/CJS and Vite checks with the optional canvas absent, and the documentation build also pass. Existing expected mismatch counts were tightened where rendering improved; no existing tolerance was widened.

The probes also retain evidence of an existing translucent-clamp limitation: GDI+ can write premultiplied colour channels greater than alpha, which the current straight-RGBA intermediate cannot represent. Opaque clamp controls pass; arbitrary translucent clamp output is not claimed as exact. Text, some effects, transformed gradients, and sampling coordinate ties remain priorities in [Outstanding work](./outstanding-work.md).

Reproducible standalone generators and environment manifests accompany the new tests; see the [fixture generator documentation](https://github.com/ChristopherVR/emf-converter/blob/main/scripts/gdi-fixtures/README.md). Existing references were not regenerated or replaced.

## Text follow-up

Three further GPT-6.1 Sol workstreams investigated DrawString spacing, monochrome dropout control, and Courier New antialiasing. Native Windows captures remain the reference; production playback remains portable TypeScript.

- **Supplementary Unicode:** supplied-font EMF+ DrawString decodes code points, so a surrogate pair selects one glyph and consumes one advance. SVG text retains that character and one glyph position. All 75 complete RGBA controls match native output, up from 30; the controls use a generated CC0 font across three sizes and all five explicit rendering hints. This does not implement complex-script shaping, font fallback or color emoji.
- **Courier New AntiAlias:** native regular/italic faces widen each grayscale sample row one quarter-pixel to the right. A private copy of the same font with only its family renamed confirms that this is a family-specific native rule. The fix applies only to untransformed, nonsynthetic GDI+ AntiAlias; bold and AntiAliasGridFit retain their previous rendering. Fresh controls improve from 4,188 to 4,845 exact out of 6,400. The older regular-face AntiAlias set improves from 0 to 653 exact out of 1,128, with mismatched pixels falling from 19,873 to 4,411. No previously exact control is lost. Five already-inexact controls increase by one to four mismatched pixels; their before/after counts are explicitly recorded in the new regression test and bounds file. Existing fixture tolerances are not widened.

**Long ClearType DrawString spacing remains open.** The rounded-linear advance candidate improved 46 of 150 mixed-string captures but worsened six, so it was rejected. A second candidate using ClearType-hinted advances and the grid-fitting compensation described in [Microsoft KB307208 (archived)](https://ftp.zx.net.nz/pub/Patches/ftp.microsoft.com/MISC/KB/en-us/307/208.HTM) reduced total absolute origin error across 1,076 unambiguous repeated-glyph layouts from 83,630 to 210 pixels, but lost three previously exact one-pixel controls and worsened five mixed-string cases. Neither spacing candidate is shipped. The native captures and per-case baselines are retained for further work; endpoint, margin and mixed-run compensation still need a general rule.

**Monochrome dropout control:** straight, single-contour outlines now follow their branches through the neighboring pixel squares when deciding whether a thin tip is a stub. Smart selection quantizes both crossings to 26.6 before resolving a midpoint tie. Curved and multiple-contour outlines, grayscale and ClearType retain their previous rules. Across 29,696 native controls, exact matches rise from 23,023 to 27,610 (+4,587), with no previously exact capture lost. Every original control improves or stays unchanged. Twelve previously inexact independent/held-out controls increase from one to two differing pixels each; these are explicitly retained in the new per-case bounds. Comparisons include all output ink, even outside the native glyph's reported black box.

The smart-crossing refinement is restricted to upright, uniformly realized glyphs without synthetic shear or fractional translation. An additional 1,200 native real-font controls exposed an unresolved interaction with condensed glyph outlines: blanket refinement moved a sample in Tahoma and raised the existing styles-sheet residual from 70 to 74 pixels. Keeping the previous smart arithmetic in that context restores the original ceiling; no existing bound is raised. The neighboring-square improvement remains separately enabled.

| Native monochrome controls | Before | After |
| --- | ---: | ---: |
| Original ST1 | 3,876 / 5,120 | 5,087 / 5,120 |
| Original ST4 | 5,058 / 5,120 | 5,103 / 5,120 |
| Original ST5 | 3,916 / 5,120 | 5,087 / 5,120 |
| Independent ST1 | 2,510 / 3,584 | 3,072 / 3,584 |
| Independent ST5 | 2,560 / 3,584 | 3,097 / 3,584 |
| Held-out ST1 | 2,528 / 3,584 | 3,074 / 3,584 |
| Held-out ST5 | 2,575 / 3,584 | 3,090 / 3,584 |

The complete 870-fixture report after the text changes retains 646 exact common-area RGB comparisons and 642 with complete ink coverage. Eight existing text comparisons improve; none have more mismatched pixels. Render failures and omitted reference ink remain zero. These whole-metafile results are separate from the targeted glyph and layout captures above.

Final text-round validation: **211 test files, 7,191 tests passed**. Library and documentation type checks, package build, browser ESM/CJS and Vite checks with the optional canvas absent, and documentation build pass. All 14 input/reference hashes in the new text environment manifests match the local files. Runtime dependencies and public APIs are unchanged, and no existing residual tolerance was widened. Existing exact-count expectations were tightened where rendering improved.

The historical text measurements in Outstanding work describe earlier implementations. Native font results also depend on font versions and process state; the new captures include environment manifests and do not replace older references.

## Open-source alternatives

| Project | Useful role | Limitation for this converter |
| --- | --- | --- |
| [emf-rs](https://github.com/mythrnr/emf-rs), [wmf-rs](https://github.com/mythrnr/wmf-rs) (MIT) | Independent parsers and differential testing; Rust/WASM integration | Work in progress. The [EMF SVG player](https://github.com/mythrnr/emf-rs/blob/master/core/src/converter/svg/mod.rs) leaves several blits, clipping operations, arcs and ANSI text unimplemented. Its [EMF+ layer](https://github.com/mythrnr/emf-rs/blob/master/core/src/converter/svg/emf_plus.rs) relies on GDI fallback for Dual metafiles. Replacing the current player would lose coverage. |
| [resvg](https://github.com/linebender/resvg) / tiny-skia (Apache-2.0 OR MIT) | Deterministic rendering of generated SVG for independent verification | SVG renderer, not a metafile interpreter; upstream excludes native text rendering. It cannot supply GDI raster semantics or Windows hinting. |
| [rust-skia](https://github.com/rust-skia/rust-skia) (MIT bindings; Skia BSD-style) | Performance work after profiling | The optional [canvas backend](https://github.com/Brooooooklyn/canvas) already supplies Skia. Switching bindings does not fix GDI/GDI+ arithmetic. |
| [windows-rs](https://github.com/microsoft/windows-rs) (Apache-2.0 OR MIT bindings) | Optional Windows-native raster backend or reference-capture helper | Calls the target OS renderer, but requires Windows and matching fonts/settings. It cannot provide browser playback or an editable vector equivalent of every operation. |
| [Wine](https://github.com/wine-mirror/wine/blob/master/dlls/gdiplus/metafile.c) (LGPL-2.1-or-later for relevant source) | Behavioural tests and independent diagnostic comparisons | EMF+ playback still has unsupported pen properties and effects. It is a compatibility implementation, not the native Windows oracle. |
| [libgdiplus](https://github.com/mono/libgdiplus) (MIT core) | Algorithm research and interoperability checks | [Metafile playback stubs](https://github.com/mono/libgdiplus/blob/main/src/metafile.c) and [incomplete EMF+ handlers](https://github.com/mono/libgdiplus/blob/main/src/emfplus.c); Cairo/FreeType does not imply Windows pixel equality. |
| [libwmf](https://github.com/caolanm/libwmf) (LGPL-2.1) | WMF parser and conversion comparisons | No EMF/EMF+ engine; cannot address the GDI+ residuals. |
| [LibreOffice](https://github.com/LibreOffice/core/blob/master/drawinglayer/source/tools/emfphelperdata.cxx) (MPL-2.0 and component-specific licences) | Real-world interoperability tests and mature import infrastructure | Remaining EMF+ interpolation, pixel-offset, image-attribute and text-hint limitations, with substantial drawing-layer dependencies. |

These are upstream capabilities reviewed on the date above, not benchmarks of equivalent inputs. No new runtime dependency was adopted. Copying LGPL/MPL implementation code into this Apache-2.0 package would require preserving the applicable licence obligations; independent native measurements remain the preferred basis for fixes.

## What constitutes parity

For the portable renderer, each improvement needs a native capture of the affected operation, a reproducible probe, a recorded environment, and regression checks that preserve previously exact controls. Transparent images need premultiplied-channel or composited-background checks as well as RGB checks. Extent changes need full-area native playback, not overlap-only comparisons.

The selected product constraint is **browser/Node portability**. Literal Windows execution is only an alternative considered in this review, not an adopted backend. A helper using `windows-rs` could call [GDI metafile functions](https://learn.microsoft.com/en-us/windows/win32/gdi/metafile-functions) for classic playback and [GDI+](https://learn.microsoft.com/en-us/windows/desktop/gdiplus/-gdiplus-metafiles-about) for EMF+; `PlayEnhMetaFile` alone is insufficient for EMF+ Only. Its output would still depend on the OS, device and fonts. Native PNG/JPEG output, or an SVG containing that raster output, would not replace the existing editable SVG path.

Prioritise confirmed arithmetic errors in the existing engine, followed by full-extent/alpha validation and text controls with known fonts. Use Rust for profiled performance bottlenecks or a separately specified native backend, rather than a rewrite intended to obtain parity automatically.
