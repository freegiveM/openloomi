import dynamic from "next/dynamic";

// Bundle optimization: tiptap + prosemirror is ~hundreds of KB and is only
// used on the scheduled-job pages. Lazy-load the component so it doesn't
// ship with the (chat) layout chunk. Re-exports `NovelInstructionEditorRef`
// so consumers can keep using `forwardRef<NovelInstructionEditorRef>` (the
// type itself isn't bundled — TS strips it at build time).
export const NovelInstructionEditor = dynamic(
  () =>
    import("./novel-instruction-editor").then((mod) => ({
      default: mod.NovelInstructionEditor,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="animate-pulse min-h-[120px] bg-muted rounded-xl" />
    ),
  },
);

export type { NovelInstructionEditorRef } from "./novel-instruction-editor";
