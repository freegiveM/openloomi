"use client";

import { lazy, Suspense } from "react";

// Bundle optimization: markmap is heavy and only used for `type === "mindmap"`
// parts, so lazy-load it instead of pulling markmap-lib + markmap-view into
// the per-message chunk. The wrapper keeps the same call shape as the
// underlying MindMapPreview so consumers don't need to change.
const MindMapPreview = lazy(() =>
  import("../artifacts/mindmap-preview").then((mod) => ({
    default: mod.MindMapPreview,
  })),
);

interface MindMapPreviewDynamicProps {
  content: string;
  filename?: string;
  maxHeight?: string;
}

export function MindMapPreviewDynamic(props: MindMapPreviewDynamicProps) {
  return (
    <Suspense fallback={null}>
      <MindMapPreview {...props} />
    </Suspense>
  );
}
