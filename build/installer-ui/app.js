const features = [
  {
    label: 'Canvas',
    category: '01 / INFINITE CANVAS',
    title: 'Build your visual world.',
    description: 'Collect, arrange and connect every reference on one limitless canvas.',
    chips: ['Paste anywhere', 'Infinite workspace', 'Smart grouping'],
    image: 'shots/01-canvas.png',
  },
  {
    label: 'Precision',
    category: '02 / PRECISION',
    title: 'Focus on every detail.',
    description: 'Crop, rotate, compare and inspect references without sacrificing original quality.',
    chips: ['Original quality', 'Crop & rotate', 'Pixel-level zoom'],
    image: 'shots/02-precision.png',
  },
  {
    label: 'Thinking',
    category: '03 / VISUAL THINKING',
    title: 'Think directly on the canvas.',
    description: 'Draw, annotate, add notes and connect ideas without leaving your board.',
    chips: ['Draw & annotate', 'Notes', 'Arrows & links'],
    image: 'shots/03-thinking.png',
  },
  {
    label: 'Animatics',
    category: '04 / ANIMATICS',
    title: 'Turn references into motion.',
    description: 'Shape timing with layered visuals, text, audio and precise track controls.',
    chips: ['Layered timeline', 'Audio waveforms', 'In / out control'],
    image: 'shots/04-animatics.png',
  },
  {
    label: 'Export',
    category: '05 / EXPORT',
    title: 'Ready for your next workflow.',
    description: 'Save your board, export at full resolution and hand off your animatic to production.',
    chips: ['PNG & originals', '.refboard files', 'Premiere / After Effects'],
    image: 'shots/05-export.png',
  },
];

const sceneDuration = 7200;
const sceneStack = document.querySelector('#sceneStack');
const copyStage = document.querySelector('#copyStage');
const featureTabs = document.querySelector('#featureTabs');
const previousButton = document.querySelector('#previousButton');
const nextButton = document.querySelector('#nextButton');
const playButton = document.querySelector('#playButton');
const sceneTimer = document.querySelector('#sceneTimer');
const installButton = document.querySelector('#installButton');
const installState = document.querySelector('#installState');
const installMeta = document.querySelector('#installMeta');
const installPercent = document.querySelector('#installPercent');
const progressTrack = document.querySelector('#progressTrack');
const installProgressBar = document.querySelector('#installProgressBar');
const progressGlow = document.querySelector('.progress-glow');

let activeIndex = 0;
let autoTimer = null;
let paused = false;
let installing = false;
let installComplete = false;
let realInstallDone = false;
let realInstallOk = true;

if (window.RefBoardInstaller?.onComplete) {
  window.RefBoardInstaller.onComplete((result) => {
    realInstallDone = true;
    realInstallOk = !result || result.ok !== false;
  });
}

const sceneElements = features.map((feature, index) => {
  const scene = document.createElement('div');
  scene.className = `scene${index === 0 ? ' is-active' : ''}`;
  scene.style.backgroundImage = `url("${feature.image}")`;
  sceneStack.append(scene);
  return scene;
});

const tabElements = features.map((feature, index) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `feature-tab${index === 0 ? ' is-active' : ''}`;
  button.textContent = feature.label;
  button.setAttribute('aria-label', `Show ${feature.label} feature`);
  button.addEventListener('click', () => showFeature(index, true));
  featureTabs.append(button);
  return button;
});

function renderCopy(feature) {
  const chips = feature.chips
    .map((chip) => `<span class="feature-chip">${chip}</span>`)
    .join('');

  copyStage.innerHTML = `
    <div class="feature-number" style="--delay: 80ms">${feature.category}</div>
    <h1 class="feature-title" style="--delay: 150ms">${feature.title}</h1>
    <p class="feature-description" style="--delay: 240ms">${feature.description}</p>
    <div class="feature-chip-row" style="--delay: 330ms">${chips}</div>
  `;
}

function restartSceneTimer() {
  sceneTimer.classList.remove('is-paused');
  sceneTimer.style.animation = 'none';
  void sceneTimer.offsetWidth;
  sceneTimer.style.animation = '';
  if (paused) sceneTimer.classList.add('is-paused');
}

function scheduleNext() {
  clearTimeout(autoTimer);
  if (paused || installing) return;
  autoTimer = setTimeout(() => showFeature((activeIndex + 1) % features.length), sceneDuration);
}

function showFeature(nextIndex, fromUser = false) {
  if (nextIndex === activeIndex && fromUser) {
    restartSceneTimer();
    scheduleNext();
    return;
  }

  const previousScene = sceneElements[activeIndex];
  const nextScene = sceneElements[nextIndex];

  previousScene.classList.remove('is-active');
  previousScene.classList.add('is-leaving');
  nextScene.classList.remove('is-leaving');
  requestAnimationFrame(() => nextScene.classList.add('is-active'));
  setTimeout(() => previousScene.classList.remove('is-leaving'), 1200);

  activeIndex = nextIndex;
  renderCopy(features[activeIndex]);
  tabElements.forEach((tab, index) => tab.classList.toggle('is-active', index === activeIndex));
  restartSceneTimer();
  scheduleNext();
}

function setPaused(nextPaused) {
  paused = nextPaused;
  playButton.classList.toggle('is-paused', paused);
  playButton.setAttribute('aria-label', paused ? 'Resume feature slideshow' : 'Pause feature slideshow');
  playButton.setAttribute('aria-pressed', String(paused));
  sceneTimer.classList.toggle('is-paused', paused);
  scheduleNext();
}

function setInstallProgress(value, label, meta) {
  const progress = Math.max(0, Math.min(100, value));
  installProgressBar.style.width = `${progress}%`;
  progressGlow.style.left = `${progress}%`;
  installPercent.textContent = `${Math.round(progress)}%`;
  installState.textContent = label;
  if (meta) installMeta.textContent = meta;
  progressTrack.setAttribute('aria-valuenow', String(Math.round(progress)));
}

function animateInstallPhase(from, to, duration, label, meta) {
  return new Promise((resolve) => {
    const startedAt = performance.now();

    const tick = (now) => {
      const elapsed = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - elapsed, 3);
      setInstallProgress(from + (to - from) * eased, label, meta);
      if (elapsed < 1) requestAnimationFrame(tick);
      else resolve();
    };

    requestAnimationFrame(tick);
  });
}

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

  const hasBridge = Boolean(window.RefBoardInstaller?.start);
  if (hasBridge) {
    window.RefBoardInstaller.start();
  }

  await animateInstallPhase(0, 10, 650, 'Preparing RefBoard\u2026', 'Checking installation requirements');
  await animateInstallPhase(10, 66, 2300, 'Installing RefBoard\u2026', 'Copying application files');
  await animateInstallPhase(66, 81, 720, 'Creating shortcuts\u2026', 'Adding Start menu and desktop shortcuts');
  await animateInstallPhase(81, 94, 900, 'Connecting Windows\u2026', 'Registering .refboard files and previews');

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
    installComplete = false;
    installButton.disabled = false;
    return;
  }

  installState.textContent = 'RefBoard is ready';
  installMeta.textContent = 'Installation completed successfully';
  installButton.querySelector('.button-label').textContent = 'Launch RefBoard';
  installButton.disabled = false;
  installButton.querySelector('svg').innerHTML = '<path d="m7 5 8 5-8 5Z" fill="currentColor" stroke="none"/>';
}

previousButton.addEventListener('click', () => showFeature((activeIndex - 1 + features.length) % features.length, true));
nextButton.addEventListener('click', () => showFeature((activeIndex + 1) % features.length, true));
playButton.addEventListener('click', () => setPaused(!paused));
installButton.addEventListener('click', simulateInstall);

document.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft') showFeature((activeIndex - 1 + features.length) % features.length, true);
  if (event.key === 'ArrowRight') showFeature((activeIndex + 1) % features.length, true);
  if (event.key === ' ') {
    event.preventDefault();
    setPaused(!paused);
  }
});

document.querySelectorAll('[data-window-action]').forEach((button) => {
  button.addEventListener('click', () => {
    const action = button.dataset.windowAction;
    if (window.RefBoardInstaller?.[action]) window.RefBoardInstaller[action]();
  });
});

renderCopy(features[0]);
restartSceneTimer();
scheduleNext();
