# README screenshots

These are captures of RefBoard's actual Electron renderer. The board content,
recent-work entries, and titles are demo fixtures. No personal app profile,
history, clipboard content, saved board, or thumbnail cache is read.

| File | View |
|---|---|
| `board.png` | Sample landscape board with notes and color swatches |
| `library.png` | Classic Grid with six fictional recent boards |
| `focus-flow.png` | Focus Flow browsing the same sample library |

The front-page icon uses the existing [`build/icon.png`](../../build/icon.png).

## Reproduce

From the repository root on Windows, after `npm ci`:

```powershell
npx --no-install electron scripts/capture-readme.cjs
```

The script downloads six fixed public sample photos from [Lorem Picsum](https://picsum.photos/)
on its first run and caches them in the ignored `stress-out-smoke/readme/samples/`
directory. It starts a hidden 1600 × 1000 Electron window with a new temporary
profile and no desktop IPC preload. Home uses a separate in-memory session.
It imports the sample photos into the real canvas, adds demo notes, and captures
three PNGs. The app UI is not restyled or composited for the screenshots. PNG
compression is lossless. No image-generation service is used.

The temporary profile is removed on completion where Windows has released its
file handles; a locked profile is reported by the cleanup helper.

## Photo credits

Photographs are from Unsplash, supplied through Lorem Picsum, and used under
the [Unsplash License](https://unsplash.com/license). They retain their own
license; the app's MIT license does not relicense these photographs.

| Picsum ID | Photographer | Original photo |
|---|---|---|
| 1015 | Alexey Topolyanskiy | [Mountain overlook](https://unsplash.com/photos/-oWyJoSqBRM) |
| 1016 | Philippe Wuyts | [Desert landscape](https://unsplash.com/photos/_h7aBovKia4) |
| 1018 | Andrew Ridley | [Misty highlands](https://unsplash.com/photos/Kt5hRENuotI) |
| 1039 | Andrew Coelho | [Forest waterfall](https://unsplash.com/photos/VB-w_3dnyvI) |
| 1043 | Christian Joudrey | [Mountain valley](https://unsplash.com/photos/mWRR1xj95hg) |
| 106 | Arvee Marie | [Flowers against the sky](https://unsplash.com/photos/YnfGtpt2gf4) |

Each sample is requested at `https://picsum.photos/id/<id>/1200/800`.
