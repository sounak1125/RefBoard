# Changes to build/installer-ui/app.js

Only TWO edits. Everything else stays exactly as you built it. The timed animation
is preserved — we just make it wait for the REAL install to finish before flipping
to "ready", and hand launch off to the bootstrapper.

Your app.js already guards everything with `window.RefBoardInstaller?.` so these edits
stay 100% backward-compatible: in a plain browser preview (no bootstrapper) it behaves
exactly as it does now. Under the bootstrapper, it drives the real install.

---

## EDIT 1 — add two state vars (near the top, with the other `let` declarations)

Find:

    let installing = false;
    let installComplete = false;

Replace with:

    let installing = false;
    let installComplete = false;
    let realInstallDone = false;   // true once the actual NSIS process exits
    let realInstallOk = true;      // whether that process exited cleanly

Then, right after those declarations, add this listener so we learn when the real
install truly finishes:

    if (window.RefBoardInstaller?.onComplete) {
      window.RefBoardInstaller.onComplete((result) => {
        realInstallDone = true;
        realInstallOk = !result || result.ok !== false; // treat unknown as ok
      });
    }

---

## EDIT 2 — replace the whole `simulateInstall` function

Replace your existing `async function simulateInstall() { ... }` with the version
below. The differences from yours:
  - it calls `window.RefBoardInstaller.start()` to begin the REAL install
  - the phases animate to 94% as before, then it WAITS for the real process to
    finish before the final 94->100 sweep (so the bar never claims done early)
  - in a browser with no bootstrapper, it falls back to your original pure-timed
    behaviour automatically

    async function simulateInstall() {
      if (installComplete) {
        if (window.RefBoardInstaller?.launch) window.RefBoardInstaller.launch();
        else {
          installState.textContent = 'Launch is ready';
          installMeta.textContent = 'The packaged installer will now open RefBoard.';
        }
        return;
      }
      if (installing) return;
      installing = true;
      document.body.classList.add('is-installing');
      installButton.disabled = true;
      installButton.querySelector('.button-label').textContent = 'Installing\u2026';

      // Kick off the REAL silent install (no-op in a plain browser preview).
      const hasBridge = Boolean(window.RefBoardInstaller?.start);
      if (hasBridge) {
        // fire-and-forget; completion arrives via onComplete -> realInstallDone
        window.RefBoardInstaller.start();
      }

      await animateInstallPhase(0, 10, 650, 'Preparing RefBoard\u2026', 'Checking installation requirements');
      await animateInstallPhase(10, 66, 2300, 'Installing RefBoard\u2026', 'Copying application files');
      await animateInstallPhase(66, 81, 720, 'Creating shortcuts\u2026', 'Adding Start menu and desktop shortcuts');
      await animateInstallPhase(81, 94, 900, 'Connecting Windows\u2026', 'Registering .refboard files and previews');

      // Hold at 94% until the REAL install process has actually exited.
      // (In a browser preview with no bridge, we skip the wait.)
      if (hasBridge) {
        installState.textContent = 'Finishing setup\u2026';
        installMeta.textContent = 'Completing installation';
        while (!realInstallDone) {
          await new Promise((r) => setTimeout(r, 150));
        }
      }

      await animateInstallPhase(94, 100, 720, 'Finishing setup\u2026', 'Applying the final configuration');

      installing = false;
      installComplete = true;
      document.body.classList.remove('is-installing');
      document.body.classList.add('is-complete');

      if (hasBridge && !realInstallOk) {
        installState.textContent = 'Installation needs attention';
        installMeta.textContent = 'The installer did not complete cleanly. Please try again.';
        installButton.querySelector('.button-label').textContent = 'Retry install';
        installComplete = false;      // allow a retry
        installButton.disabled = false;
        return;
      }

      installState.textContent = 'RefBoard is ready';
      installMeta.textContent = 'Installation completed successfully';
      installButton.querySelector('.button-label').textContent = 'Launch RefBoard';
      installButton.disabled = false;
      installButton.querySelector('svg').innerHTML = '<path d="m7 5 8 5-8 5Z" fill="currentColor" stroke="none"/>';
    }

---

## That's it.

No other changes. Your slideshow, transport controls, keyboard handling, window
buttons, and styling are untouched. The window minimize/close already work because
your app.js calls `window.RefBoardInstaller[action]()` and the preload now provides
`minimize` and `close`.
