# RefBoard installer cinematic shots

Generated on 2026-07-17 from a clean disposable RefBoard profile using synthetic demo artwork. The app was captured through an external Electron/CDP session at 2560×1440; the Codex in-app browser was not used.

## Delivery files

- `final/01-build-your-visual-world.png`
- `final/02-focus-on-every-detail.png`
- `final/03-think-directly-on-the-canvas.png`
- `final/04-turn-references-into-motion.png`
- `final/05-ready-for-your-next-workflow.png`

The first four shots were reference-image edits made with Codex's built-in `image_gen` path, followed by high-quality bicubic delivery scaling to 2560×1440. For shot 5, both image-generation passes were rejected because they invented background controls. The accepted file instead uses the authentic 2560×1440 source capture with a deterministic, geometry-preserving charcoal/blue color finish.

## Source captures

- `sources/source-01-moodboard.png`
- `sources/source-02-focus.png`
- `sources/source-03-annotation.png`
- `sources/source-04-animatics.png`
- `sources/source-05-export.png`

## Accepted image-generation prompts

### Shot 1

> Use case: UI mockup for a premium desktop installer cinematic.
> Asset type: finished 16:9 installer showcase still, 2560x1440 landscape.
> Edit the supplied RefBoard screenshot itself. Preserve the exact full-screen RefBoard interface, left toolbar, dotted infinite canvas, image-card positions, proportions, and all visible controls. Do not redesign, remove, add, rewrite, or relocate any UI. Do not invent text or logos.
> Shot purpose: "Build your visual world" — an expansive infinite moodboard with many visual references.
> Enhancement only: premium dark-charcoal cinematic color grade, restrained electric-blue rim lighting around the application edges, subtly richer image-card contrast, soft realistic card shadows, very gentle depth falloff toward the far edges, refined antialiasing, faint atmospheric glow, clean high-end installer presentation. Keep everything crisp and legible, especially UI icons.
> No monitor, laptop, desk, room, hands, person, watermark, NVIDIA/Adobe branding, extra captions, fake UI, perspective warp, or cropping.

### Shot 2

> Use case: UI mockup for a premium desktop installer cinematic.
> Asset type: finished 16:9 installer showcase still, 2560x1440 landscape.
> Edit the supplied RefBoard screenshot itself. Preserve the exact full-screen RefBoard interface, selected artwork, blue selection boundary and handles, top selection toolbar, left tool rail, dotted canvas, neighboring reference slivers, and every visible UI control. Do not redesign or invent UI or text.
> Shot purpose: "Focus on every detail" — one selected reference dominates the canvas while the real app chrome stays visible.
> Enhancement only: elegant deep-charcoal grade, restrained blue edge glow that complements the existing selection outline, richer but natural violet/orange artwork, subtle focus falloff outside the selected image, polished antialiasing and high-end contrast. The selected image remains the sharpest focal point; UI remains crisp and flat, not a 3D mockup.
> No monitor, laptop, room, hands, person, watermark, external brand marks, captions, fake buttons, perspective distortion, cropping, or replaced artwork.

### Shot 3

> Use case: UI mockup for a premium desktop installer cinematic.
> Asset type: finished 16:9 installer showcase still, 2560x1440 landscape.
> Edit the supplied RefBoard screenshot itself. Preserve the exact full-screen RefBoard interface, selected artwork, existing black annotation strokes, blue selection boundary and handles, top selection toolbar, left main toolbar, expanded DRAW tool panel and every icon/control. Do not redesign, add, remove, rewrite, or relocate interface elements.
> Shot purpose: "Think directly on the canvas" — authentic drawing and annotation in progress.
> Enhancement only: premium dark-charcoal cinematic grade, subtle electric-blue accent glow around active tools and selection, gentle local contrast that makes the existing strokes readable, refined UI sharpness, faint edge vignette and soft depth. Keep the actual annotation marks and artwork unchanged.
> No monitor, laptop, studio environment, hand, stylus, person, watermark, captions, other brand marks, fake text, new drawings, perspective warp, or cropping.

### Shot 4

> Use case: UI mockup for a premium desktop installer cinematic.
> Asset type: finished 16:9 installer showcase still, 2560x1440 landscape.
> Edit the supplied real RefBoard Animatics screenshot itself. Preserve the exact stacked RefBoard/ANIMATICS header, inspector, preview artwork, transport, complete multi-track timeline, clips, text layer, audio waveforms, time ruler, in/out markers, tool icons, labels and all spacing. Do not invent, delete, rewrite, or relocate UI or text.
> Shot purpose: "Turn references into motion" — a sophisticated working animatic with layered video, text and audio.
> Enhancement only: premium deep-charcoal cinematic color grade, restrained RefBoard blue accents, slightly richer preview colors, subtle timeline depth and separation, gentle viewer glow, crisp readable typography and waveforms, refined high-end installer presentation. Keep it a straight-on full-screen application capture.
> No monitor, laptop, desk, room, person, watermark, NVIDIA/Adobe logos, captions, fake tracks, extra controls, perspective warp, blur over text, or cropping.

## Rejected image-generation prompt for shot 5

This prompt was used, but its output was not delivered because the generator changed parts of the background UI:

> Use case: UI mockup for a premium desktop installer cinematic.
> Asset type: finished 16:9 installer showcase still, 2560x1440 landscape.
> Edit the supplied real RefBoard Animatics export screenshot itself. Preserve the exact centered Export animatic dialog, After Effects project builder selection, resolution, frame rate, export range, Cancel and Export After Effects buttons, dimmed authentic Animatics editor, preview, tool panels and timeline. All existing text must remain accurate, legible and unchanged. Do not add, remove, rewrite, or relocate UI.
> Shot purpose: "Ready for your next workflow" — a polished export handoff from RefBoard.
> Enhancement only: premium charcoal/black grade, restrained electric-blue glow on the primary export button and dialog edge, gentle modal depth, soft background falloff, refined antialiasing and installer-grade contrast. Keep the modal as the sharp focal point and the authentic interface visible behind it.
> No monitor, laptop, room, hand, person, watermark, Adobe logo, NVIDIA logo, caption text, new brand marks, fake settings, perspective warp, or cropping.

A stricter pixel-lock retry was also rejected for the same reason. The delivered shot 5 therefore uses the authentic source pixels with only a deterministic color matrix; no geometry or text was regenerated.
