# notes.

Pages, daily notes and tasks written in notes. Plan: the "notes. — scope" Claude Doc.
Stage 0 (now): a test of the editor inside lifeOS's shadow root on iPhone Safari; the note stays on the device.

## The editor

`/lifeos/vendor/tiptap-3.31.3.js` is TipTap bundled into one file, like supabase-js. To rebuild it (pin every package to the same version):

```sh
npm i @tiptap/core@3.31.3 @tiptap/pm@3.31.3 @tiptap/starter-kit@3.31.3 @tiptap/extension-list@3.31.3 @tiptap/extensions@3.31.3 esbuild
# entry.js:
#   export { Editor } from "@tiptap/core";
#   export { default as StarterKit } from "@tiptap/starter-kit";
#   export { TaskList, TaskItem } from "@tiptap/extension-list";
#   export { Placeholder } from "@tiptap/extensions";
npx esbuild entry.js --bundle --format=esm --minify --target=safari15 --legal-comments=eof --outfile=tiptap-3.31.3.js
```

TipTap's own stylesheet can't reach a shadow root (`injectCSS: false`), so `app.css` carries the rules ProseMirror needs. Checklist items are `ul[data-type="taskList"] > li` (TipTap 3 puts no data-type on the li).
