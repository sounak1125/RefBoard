# RefBoard cinematic installer UI

This folder contains the animated presentation layer for the custom RefBoard installer.

Open `index.html` to preview it. The mockup uses the five supplied 2688 × 1520 feature images as clean background layers. All text, controls, transitions, and progress states remain live UI so they stay crisp, accessible, and editable.

## Interaction

- Crossfades automatically every 7.2 seconds.
- Text enters with a staggered fade, lift, and blur resolve.
- Backgrounds use a restrained scale drift during transitions.
- Canvas, Precision, Thinking, Animatics, and Export buttons jump directly to a feature.
- Previous, next, and pause/resume controls are available.
- Left/right arrows navigate; Space pauses or resumes.
- The install button opens a visible progress panel with percentage, current task, and smooth staged progress.
- Completion transforms the primary action into `Launch RefBoard` and leaves the bar at 100%.
- Reduced-motion preferences disable the cinematic movement.

## Installer bridge

The visual layer intentionally does not perform privileged installation work itself. A custom Electron installer host should expose a narrow `window.RefBoardInstaller` bridge:

```js
window.RefBoardInstaller = {
  minimize(),
  close(),
  beginInstall(),
  launch(),
  onProgress(callback),
};
```

The current browser-safe mockup simulates installation progress when no host bridge is present. When embedded in the installer host, replace `simulateInstall()` with `beginInstall()` and update the progress bar from `onProgress()` events.

The packaged installer host should keep the existing electron-builder/NSIS payload and update behavior as its backend. This folder replaces the visible installer experience, not the proven install/uninstall mechanics.

## Recommended host window

- Frameless Electron window.
- Default size: 1180 × 720.
- Minimum size: 880 × 640.
- Non-resizable for the shipped installer unless responsive QA is completed at additional sizes.
- Context isolation enabled and Node integration disabled.
- Only the bridge methods above exposed from preload.
