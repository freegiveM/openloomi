import type React from "react";
import type { Attachment } from "@openloomi/shared";

export type TaskComposerPlacement = "centered" | "docked";

export interface TaskComposerSubmitPayload {
  text: string;
  attachments: Attachment[];
}

export interface TaskComposerProps {
  value: string;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  onSubmit: (payload: TaskComposerSubmitPayload) => void | Promise<void>;
  onStop?: () => void;
  isAgentRunning?: boolean;
  isSending?: boolean;
  isSubmitting?: boolean;
  isLocked?: boolean;
  placement?: TaskComposerPlacement;
  placeholder?: string;
  className?: string;
  layoutId?: string;
  isUploadingFile?: boolean;
  onFilesSelected?: (files: FileList | File[] | null) => Promise<void> | void;
  enableDropzone?: boolean;
}
