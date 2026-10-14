# notes.

Pages, daily notes and tasks written in notes. Plan: the "notes. — scope" Claude Doc.
Stage 1: notes in Supabase (`sql/notes.sql`), in the spaces my / work / joint, saved as you type, a 30-day bin, a / menu and a microphone button.

## The editor

`/lifeos/vendor/tiptap-3.31.3.js` is TipTap bundled into one file, like supabase-js. To rebuild it (pin every package to the same version):

```sh
npm i @tiptap/core@3.31.3 @tiptap/pm@3.31.3 @tiptap/starter-kit@3.31.3 @tiptap/extension-list@3.31.3 @tiptap/extensions@3.31.3 @tiptap/suggestion@3.31.3 @tiptap/extension-image@3.31.3 esbuild
# entry.js:
#   export { Editor, Extension, Node, mergeAttributes } from "@tiptap/core";
#   export { default as StarterKit } from "@tiptap/starter-kit";
#   export { TaskList, TaskItem } from "@tiptap/extension-list";
#   export { Placeholder } from "@tiptap/extensions";
#   export { Suggestion } from "@tiptap/suggestion";
#   export { default as Image } from "@tiptap/extension-image";
npx esbuild entry.js --bundle --format=esm --minify --target=safari15 --legal-comments=eof --outfile=tiptap-3.31.3.js
```

Imported as `tiptap-3.31.3.js?v=N`: raise N after a rebuild, or phones keep the cached copy. TipTap's own stylesheet can't reach a shadow root (`injectCSS: false`), so `app.css` carries the rules ProseMirror needs. Checklist items are `ul[data-type="taskList"] > li` (TipTap 3 puts no data-type on the li).
