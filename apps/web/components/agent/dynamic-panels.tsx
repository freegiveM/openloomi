import dynamic from "next/dynamic";

// File preview component (for mask and drawer)
export const FilePreviewPanel = dynamic(
  () =>
    import("@/components/file-preview-panel").then((m) => ({
      default: m.FilePreviewPanel,
    })),
  { ssr: false },
);

// WebsitePreviewDrawer component - lazy load
export const WebsitePreviewDrawer = dynamic(
  () =>
    import("@/components/agent/website-preview-drawer").then((m) => ({
      default: m.WebsitePreviewDrawer,
    })),
  { ssr: false },
);
