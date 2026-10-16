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

## Alignment and collapsed monochrome boxes

The next GPT-6.1 Sol round adds single-line EMF+ DrawString horizontal and vertical alignment for supplied fonts under unscaled, unrotated AntiAlias rendering. Native layout uses tracked design advances, cell-height metrics, default margins, trailing-space measurement flags and float32 layout origins. The new path accepts Latin/common/private-use characters with mapped glyphs; combining marks, formatting controls and other scripts keep their prior rendering path. Default-format italic black-box fitting, grid-fitted alignment, wrapping, trimming, complex shaping and transformed layout remain open; unsupported cases retain their existing path.

Across 2,592 new Windows captures, 1,728 comparisons improve and none worsens. Exact complete RGBA comparisons increase from 78 to 701; the portable CC0-font subset increases from 42 to 375 of 432. The controls cover all nine horizontal/vertical alignment combinations, default and typographic formats, regular/italic system faces, six sizes, fractional rectangles and trailing-space measurement. Remaining glyph raster and run-spacing residuals are retained as per-case ceilings rather than described as exact alignment output.

Collapsed monochrome control boxes now select the positive-axis sample when no pixel centre lies inside the box. The sole forced sample is retained through straight-contour stub exclusion. This fixes all twelve one-to-two-pixel tradeoffs from the preceding round. The existing 29,696 controls gain another 215 exact matches with no per-case increase; all 15,360 original ST1/ST4/ST5 controls are exact. A fresh signed-phase, two-axis boundary sweep improves from 4,880 to **10,240 / 10,240 exact**. Curved and multiple-contour black-box placement is corrected without changing their stub rules.

Further ClearType spacing and grayscale dropout candidates were rejected because independent mixed-text or polygon controls worsened. The new Courier geometry diagnostic contains 3,200 native surfaces and generated CC0 fonts with identical outlines under different family names; it preserves 1,393 exact controls and per-case bounds without changing production rendering.

The 870-metafile report retains 646 exact common-area RGB comparisons and 642 with complete ink coverage. Five existing text comparisons improve, none worsens, and there are no render failures or omitted native ink. Browser/Node playback remains portable TypeScript with no added runtime dependency.

Validation: 214 test files and 7,203 tests pass, together with library/documentation type checks, package/documentation builds and browser ESM/CJS/Vite checks with optional canvas absent. All 18 native input/reference hashes in the four new environment manifests match. The additional shaping guard is checked against 36 native controls; existing residual ceilings are not widened.

## Further text and reference coverage

A further GPT-6.1 Sol fanout improves ClearType baselines, scaled text alignment and multiple-contour monochrome rasterization. Every accepted change preserves existing per-case ceilings in the native controls.

**Scaled text alignment:** the verified single-line AntiAlias path now accepts positive uniform scales when the effective em is a whole device pixel. It transforms the layout rectangle into device units and respects float32 em multiplication. Across 2,880 fresh native controls, 1,824 improve and none worsens; exact complete RGBA controls rise from 126 to 1,092. Held-out scales, translated rectangles, private/system fonts and typographic italic runs are included, with 177 additional SVG ink-bound comparisons. Nonuniform scaling, fractional device em sizes, unsupported shaping and default italic black-box fitting retain their previous path. These controls preserve their own capture environment; earlier native references are not replaced.

**ClearType baselines:** at unit scale, integer device em and integer vertical origin, nonsynthetic fonts now use the greater of the rounded design ascent and the realized cell ascent, including VDMX metrics. Across 2,320 fresh controls covering five faces, four requested styles, both formats, sizes 7-40 and held-out mixed strings, 1,038 improve and none worsens; exact controls rise from 408 to 835. Eighty of the 150 older mixed-string captures improve, with no increased residual and 13 becoming exact. Synthetic styles, scaled transforms and fractional origins retain their existing behavior. Long-run compensation and kerning remain unresolved: a combined candidate regressed two controls, so no kern parser or compensation rewrite is shipped.

**Separated monochrome contours:** the neighboring-square continuation rule now extends to convex straight components whose control boxes are more than one pixel apart on at least one axis. Both dropout crossings must belong unambiguously to the same component. Curved, concave, overlapping and nearby components retain their prior rules. The 29,696 existing controls gain 671 exact matches (27,825 to 28,496); 32,256 new controls from three seeds gain 601 (22,874 to 23,475). None loses exactness or increases its per-case error. A conservative contour-count cap bounds the additional eligibility work. Independent review and real-font/condensed checks preserve the existing rendering bounds.

Three expanded native references now reproduce every RGB pixel of their original captures and include 328 previously uncaptured ink pixels. They cover two mirrored geometry cases and a mapped clipping-region case. The negative control-point bound of one geometry case contains no painted ink; preserving the original device grid avoids the native playback differences introduced by translating that bound. This closes three coverage gaps without replacing any original reference or changing rendering. The validated extent set grows from 101 to 104, with 73 exact controls rather than 71.

Image-coordinate experiments were unshipped on 12 October 2026 (float32 sample/term rounding and fixed-point row steppers reduced some bilinear phase errors but increased others). Round 7 (15 October 2026) found why: GDI+ steps a row in float32 rounded toward minus infinity from a float32 inverse matrix that is itself formed with that rounding, and the drift is a function of the coordinate's magnitude, so neither candidate captured it. The model is shipped with the native sweeps that isolate the stage; see "Round 7" in [Outstanding work](./outstanding-work.md).

Final validation for this batch: **217 test files and 7,229 tests pass**. Library and documentation type checking, package and documentation builds, and browser ESM/CJS/Vite checks with optional canvas absent pass. All 29 input/reference hashes in the four new environment manifests match. The 870-metafile report has no increased mismatched-pixel counts and retains 646 exact common-area comparisons; validated complete RGB coverage increases from 642 to 644, with the uncaptured-reference count reduced from 14 to 11. Render failures and omitted native ink remain zero. The whole-metafile set does not exercise every newly improved text control, so its exact common-area count is unchanged.

For complex shaping, [HarfBuzz](https://harfbuzz.github.io/shaping-and-shape-plans.html) is a promising portable component rather than a complete layout replacement: [bidi segmentation, fallback and paragraphs remain separate](https://harfbuzz.github.io/what-harfbuzz-doesnt-do.html). The [JavaScript/WASM binding](https://github.com/harfbuzz/harfbuzzjs) could initialize before the converter's async entry point, but its ESM/WASM packaging needs browser and CJS validation. A next proof of concept should preserve font-byte/TTC-face identity, feed shaped glyph IDs and explicit offsets into the raster engine, and represent contextual glyphs correctly in SVG. Generated CC0 Arabic substitutions and Latin combining marks should be checked against native Uniscribe glyph positions and GDI+ DrawString/DriverString output before enabling that path. No shaping dependency is added in this batch.

## Round 7 (15 October 2026)

Twelve workstreams, each starting from a native probe that isolates one stage, were merged together and measured as one tree. Against the same 870 report comparisons as the baseline at `ebac1db` (v4.20.3), **752 are RGB-exact, up from 646**. 174 comparisons improve, none worsens, and the mismatched pixels over those comparisons fall from 269,403 to 78,594. With the 28 new mirrored wide-pen sheets the report covers 898 comparisons, 777 exact and 769 with complete ink coverage. There are no render failures, no omitted reference ink, and 9 comparisons with rendered ink beyond the captured reference (11 before). Some text comparisons now use native playback references (`playback-references.json`), because a metafile records GDI's rounded advances and the directly drawn PNGs cannot be reproduced from the recording.

Native rules recovered in this round (details in [Limitations](./limitations.md) and [Outstanding work](./outstanding-work.md)):

- **EMF+ image effects** run on the premultiplied playback bitmap; the shared 96-pixel residual of about 30 effect fixtures and the blur and sharpen residuals are closed.
- **EMF+ sampling coordinates** step in float32 rounded toward minus infinity, with a float32 inverse matrix; translucent clamp colours are literal premultiplied bytes; rotated plain Bicubic uses the integer pipeline.
- **EMF+ Inset pens** are a double-width stroke clipped to the figure, antialiased through a pixel-staircase outline (a hole that touches itself at a corner splits into separate holes; each figure of a path is outlined on its own, clipped by the path's fill mode); nominal-width up to 1.5 pixels; dashed, flat caps are the doubled pen clipped and round caps a band along the inside; round joins through turns under about 8 degrees are smooth. Round pen caps and joins are GDI+'s own Bezier flattening, a square cap has two vertices, and a custom-capped line has a clipped miter.
- **SourceCopy gradients** use GDI+'s truncating unpremultiply and coverage-scaled edges.
- **GDI geometry**: the matrix nib for wide pens under unequal maps that mirror x, the dot nib at whole-pixel positions, and the RoundRect corner half extent `round(hb * c / w)`; every unmirrored `compat-playback` sheet is exact.
- **Text**: GDI's per-product projection, move and IUP arithmetic (hinted GGO_NATIVE outlines match for 1,591 of 1,598 compared glyphs), rotated layout from linear 28.4 advances, the exact GDI grayscale and ClearType blends, ClearType vertical smoothing and gasp rules, natural ClearType widths, the raster font mapper, bold italic and decorations of raster fonts, and whole-pixel GDI+ SingleBitPerPixel origins.
- **CMYK JPEG**: the Windows ICM ink-position map, integer tetrahedral weights, 8-bit rule and exact nodes; all eight CMYK/YCCK references are exact. This adds about 83 KB to the bundle.

Validation: 237 test files and 7,747 tests pass, together with library and documentation type checks, the package build and the browser-package check. No existing tolerance was widened. Open items, with their negative results, include GDI+ ClearType and grayscale text (which keep the previous hinting arithmetic), default-quality GDI ClearType stems, high-quality Bicubic rows, the path-gradient Gouraud tie (a candidate that trades named fixtures against independent captures is not shipped), red-eye areas with a far-off centroid in bright fields and lfWidth raster-face selection.

## Round 8 (16 October 2026)

Nine further workstreams, measured on the merged tree against the round-7 head (`f55a4d2`): of the 898 comparisons both reports share, **797 are RGB-exact, up from 777**, and the mismatched pixels fall from 78,599 to 43,353. Twelve new Inset-pen playback sheets bring the report to 910 comparisons, 803 exact and 795 with complete ink coverage. Forty-seven comparisons improve. Three get worse by one pixel each, all accepted trades: `textx-escapement-aa` and `-mono` (14 to 15, from the rotated-glyph rules) and `textx-plus-antialias` (555 to 556, from the GDI+ text rules, which also widen two non-exact alignment ceilings by one pixel). Render failures and omitted reference ink remain zero.

- **Red-eye:** all three recorded fixtures are exact. Native playback of the recordings is deterministic across fresh processes; the residual was a wrong stand-in centre (the darkness-weighted centroid of the area) and float32 truncating arithmetic.
- **Raster fonts:** the font mapper chooses each face's factors first and then compares one cost per face; `textx-fon-courier-styles` is exact. Fifty Terminal mapper rows that matched by coincidence (the fixture font set lacks native's OEM sizes) and one near-tie no longer match.
- **GDI geometry:** every mirrored compat-playback and wide-mirror sheet is exact (the other end of a nib edge parallel to the segment, the mapped orientation of wide-pen rectangles, the inside-frame RoundRect under a mirrored x). `wmf-embedded-emf` now compares with native playback and is exact.
- **EMF+ pens:** custom caps, round caps, square caps, corner-touching Inset holes and several untested Inset cases (thin, PixelOffsetMode Half, several figures) are exact; dashed Inset pens are much closer.
- **High-quality images:** reduction edges are 16.16 fixed point; the PixelOffsetMode high-quality fixtures are exact.
- **Text:** rotated glyphs are hinted unrotated at a rotation-scaled size, with directed tie rules and exact rotated metrics; GDI+ grayscale reports gray ClearType to GETINFO, grid-fit layouts use the measured advances and per-size SHPIX helpers stop after IUP[y]; GDI ClearType reports GETINFO bit 18 from `gasp` and applies compatible widths as an interpreter rule (stems shift rigidly, the advance phantom point stays at the black-and-white advance). The width rule turns 259 private-font glyph captures exact and 60 inexact; the user accepted that trade for the fixture gains.
- **Not shipped:** a path-gradient span rule that would make 7 exact alpha controls inexact.

Validation: 251 test files and 7,876 tests pass (one texture test timed out under full-suite load and passes alone), with library and documentation type checks, the package build and the browser-package check.

## Round 9 (16 October 2026, final round)

Six workstreams began by reviewing how Windows documents or is known to implement each area (Microsoft's TrueType instruction specification, the ClearType backward-compatibility white paper, the GDI and GDI+ API pages, FreeType's v40 documentation and Wine's GDI+ sources as behavioural references only; no code was copied), then confirmed each mechanism with native probes. Against the round-8 head (`d28c941`) on the same 910 comparisons, **813 are RGB-exact, up from 803**, 805 have complete ink coverage, 62 comparisons improve and none gets worse; mismatched pixels fall from 44,210 to 31,892.

How Windows does it, as now understood (each item measured here unless marked):

- **GDI text** is hinted by the font's TrueType program and scan-converted with pixel centres on the contour counted inside; dropout control follows the specification's "squares" definition of a stub (documented by Microsoft) and grayscale is the same conversion on an oversampled outline. Escapement uses a 128-step chord table for its sine and cosine.
- **GDI ClearType** runs the program on a finer horizontal grid with Microsoft's documented backward-compatibility rules; at default quality it keeps the black-and-white advance and slides each stem the program sets, while the program runs, until IUP[x] (undocumented; measured).
- **GDI+ text** advances unhinted glyphs by font-unit advances times 1.03 rounded to whole units, draws underlines and strike-outs as separate quarter-pixel bars, blends ClearType through 8-bit gamma tables in exact sixths of coverage, and applies the GM_COMPATIBLE stretch recorded in the text record.
- **GDI+ path gradients** are triangle fans shaded per scanline in single precision relative to the centre colour, rounded toward minus infinity.
- **GDI+ dashed pens** are cut into dashes first (consistent with Wine's re-implementation) and every dash is widened on its own; a dash shorter than its cap consumes the cap's length of the pattern.
- **GDI+ DrawImage** in a metafile is recorded as a three-point draw, which uses the same bilinear sampler as a rectangle draw with slightly different float arithmetic.

Accepted trades (owner decisions): the specification stub rule for GDI monochrome and gray text (20 near-tie private controls become inexact against about 9,500 gained and seven more exact fixtures), the in-program ClearType width shifts (7 default-quality glyph captures change, 54 become exact), and the centre-relative path-gradient model (one alpha control is one pixel off).

Still missing: the hinted shape of GDI+ diagonal-stem glyphs (whose native output also varies between runs), which MIRP chains GDI ClearType counts as stems in V/W/X, sub-0.004 px scan-conversion ties, ISECT on non-axis lines, falling-colour gradient spans, the linear ramp origin of rotated brushes, crossing Inset rings, high-quality wrap-mode image draws, a y-dependent x position in three-point image draws, and the measured (not derived) 2^-21 vertical bias of those draws.

Validation: 259 test files and 7,926 tests pass, with library and documentation type checks, the package build (`dist/index.mjs` 2,145,067 bytes) and the browser-package check.

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
