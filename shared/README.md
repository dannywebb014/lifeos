# shared

Code that calendar. (calhub) and tasks. (taskhub) both use. It is served from
this repo's GitHub Pages site at `/lifeos/shared/`, so there's one copy instead
of two that have to be kept in step by hand.

- `parse.js`: turns dictated or typed text into tasks (space, date, time, length)
- `todoist.js`: the Todoist API: projects, tasks, adding, closing, rescheduling (keeping a repeat), renaming
- `speech.js`: the browser's speech recognition, written into a text box

The apps import these with their own release number (`/lifeos/shared/parse.js?v=N`),
which each app's `bump.sh` raises. After changing a file here, push this repo first,
then run `./bump.sh` in both apps and push them, so phones fetch the new copy.
