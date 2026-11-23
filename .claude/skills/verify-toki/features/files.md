# Files panel

Each chat has a folder the bots in it read and write. The Files panel shows it beside the chat: browse, make folders, upload files or folders, switch grid and list views, and act on items.

## Sub-features

- `files-open` opens and closes the panel (`Files` / `Close files`).
- `files-empty` empty state `No files yet`.
- `files-folder` makes a folder through the `New folder` dialog.
- `files-upload` uploads files or a folder (`Upload files`, `Upload folder`, or drop).
- `files-view` toggles `Grid view` / `List view`.
- `files-actions` per-item `More actions for <name>`; keyboard: Enter opens, Backspace up, F2 rename, Delete deletes.

## How to get to it (user POV)

- In any chat header, `Files`.
- Breadcrumbs in `navigation "Folder path"`.

## Driving it with control-toki

Preconditions:

- Baseline run, in a chat with an empty folder (a fresh DM or the `verify-run` room from rooms-chat).

- **Open.** Run `$C click --role button --name Files --exact`. `complementary "Files"` appears with `heading "Files"` and `status: Empty`.
- **New folder.** Run `$C click --role button --name "New folder"`, `$C fill --role textbox --name "Folder name" --value evidence-folder`, `$C click --role button --name Create --exact --in "dialog:New folder"`. The list `Contents of <room>` has `evidence-folder, folder, modified ...`; the status reads `1 folder`.
- **Second view.** `$C api GET /api/rooms/<roomId>/files` returns `entries` with `{"name":"evidence-folder","kind":"dir"}`.
- **View toggle.** `$C click --role button --name "List view"`; it becomes `[pressed]`.
- **Close.** `$C click --role button --name "Close files"`.
- **Proof.** `$C snapshot --path files/folder.aria.yml`, `$C screenshot files/folder.png`.

## Gotchas

- Uploads go through an OS file picker or a drop; the driver has no file-chooser command, so `files-upload` is BLOCKED in the driver today (add `page.setInputFiles` support before claiming it).
- The panel takes the right slot and folds the Overview; at narrow widths it covers the chat.
- A DM's folder and a group's folder are different roots; get the room id from `api GET /api/rooms`.
