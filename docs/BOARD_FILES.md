# Board files

[Back to RefBoard](../README.md)

A board is one file: `Name.refboard`. It holds the layout, notes, tags, the
Explorer preview, and every original image. Move it, share it, or back it up
like any other document.

Inside, the file only ever grows on save. New or changed images are added to
the end, followed by a fresh copy of the board's index, so saving a large
board takes a moment rather than rewriting every image. Deleted images and old
indexes leave dead bytes in place until enough have piled up (4 MB and a
quarter of the file), when the next save writes a fresh compact file. A save
interrupted by a crash leaves the previous state intact.

When replacing a board file, RefBoard temporarily keeps the previous file as
`Name.refboard.bak`. A successful replacement removes this temporary backup.
If replacement is interrupted and the main file is missing, RefBoard restores
the backup when opening the board or loading recent boards. It never promotes
unfinished `.saving-*` files. Backups left by older versions are removed after
the board's next successful save or preview update.

## Older boards

- Boards saved by RefBoard 2.0.x kept every image inside one JSON file. They
  open as before and become the current format on their next successful save.
- Boards saved by RefBoard 2.1.0 and 2.1.1 came as a pair: `Name.refboard`
  plus `Name.refboard.images`. Keep the pair together until the board has
  been opened and saved once in RefBoard 2.1.2 or later; that save folds the
  images into the single file and removes the `.images` file and temporary
  `.bak` once conversion succeeds.

Boards saved by RefBoard 2.1.2 or later open only in 2.1.2 or later.
