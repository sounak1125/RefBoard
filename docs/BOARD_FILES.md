# Board files

[Back to RefBoard](../README.md)

A board is two files that belong together:

- `Name.refboard` — the board itself: items, view, tags, and the Explorer
  preview. Small (about a megabyte for a few hundred images) and rewritten
  whole on every save.
- `Name.refboard.images` — the original image bytes, appended to as images
  are added. A save that only moved things writes nothing here; a save after
  a paint or a new import appends just those images. Deleted images leave
  their bytes in place until enough have piled up (64 MB and a quarter of
  the file), when the next save copies the live images into a fresh store.

Move, copy, or back up the pair together. Renaming a board from the Home
screen renames both. Opening a `.refboard` whose `.refboard.images` is
missing tells you which file to put back. Boards saved by RefBoard 2.0.12
and earlier are single files with the images embedded; they open as before
and become a pair on their next save, with the old single file kept as
`Name.refboard.bak`. The pair requires RefBoard 2.1.0 or later.
