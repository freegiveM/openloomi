"use client";

import { useTranslation } from "react-i18next";
import {
  useRef,
  useEffect,
  useState,
  useCallback,
  useLayoutEffect,
  type LegacyRef,
} from "react";
import { createPortal } from "react-dom";
import { RemixIcon } from "@/components/remix-icon";
import { Spinner } from "@/components/spinner";
import type { UserContact } from "./types";

interface ReplyRecipientsProps {
  label: string;
  recipients: string[];
  onAdd: (recipient: string) => void;
  onRemove: (recipient: string) => void;
  placeholder: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  contactsListRef: React.RefObject<HTMLDivElement | null>;
  showContactsList: boolean;
  setShowContactsList: (show: boolean) => void;
  setActiveRecipientField: (field: "to" | "cc" | "bcc" | null) => void;
  fieldType: "to" | "cc" | "bcc";
  contacts: UserContact[];
  filteredContacts: UserContact[];
  isLoadingContacts: boolean;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  getRecipientLabel: (recipient: string) => string;
  hideLabel?: boolean;
  showReplyLabel?: boolean;
}

/**
 * Recipient input component
 * Supports To, CC, and BCC field types
 */
export function ReplyRecipients({
  label,
  recipients,
  onAdd,
  onRemove,
  placeholder,
  inputRef,
  contactsListRef,
  showContactsList,
  setShowContactsList,
  setActiveRecipientField,
  fieldType,
  contacts,
  filteredContacts,
  isLoadingContacts,
  searchQuery,
  setSearchQuery,
  getRecipientLabel,
  hideLabel = false,
  showReplyLabel = false,
}: ReplyRecipientsProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(recipients.length);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [dropdownPosition, setDropdownPosition] = useState<{
    top: number;
    left: number;
    width: number;
    placement: "bottom" | "top";
  } | null>(null);

  /**
   * Calculate the number of visible recipients
   */
  useEffect(() => {
    if (!containerRef.current || recipients.length === 0) {
      setVisibleCount(recipients.length);
      setHiddenCount(0);
      return;
    }

    // Use requestAnimationFrame to ensure DOM has been updated
    const updateVisibleCount = () => {
      const container = containerRef.current;
      if (!container) return;

      const containerWidth = container.offsetWidth;
      const children = Array.from(container.children) as HTMLElement[];

      // Find the "Reply" label if present
      const replyLabel = children.find(
        (child) =>
          child.tagName === "SPAN" &&
          child.textContent?.includes(
            t("insight.replyComposeHeading", "Reply"),
          ),
      );
      const replyLabelWidth = replyLabel ? replyLabel.offsetWidth + 8 : 0; // gap-2 = 8px

      // Find all recipient badge elements (excluding the "Reply" label and +N badge)
      // Recipient badge characteristics: contains bg-primary/10 class and is not a +N badge
      const recipientBadges = children.filter(
        (child) =>
          child.tagName === "SPAN" &&
          child.classList.contains("bg-primary/10") &&
          !child.textContent?.startsWith("+"),
      );

      if (recipients.length === 0) {
        setVisibleCount(0);
        setHiddenCount(0);
        return;
      }

      const gap = 8; // gap-2 = 8px
      const padding = 16; // Container padding

      // Calculate average badge width (using rendered badges as reference)
      // If badges are already rendered, use their average width; otherwise use estimated value
      let avgBadgeWidth = 90; // Default estimated value (badge max-w-[100px] minus padding and gap)
      if (recipientBadges.length > 0) {
        const totalBadgeWidth = recipientBadges.reduce(
          (sum, badge) => sum + badge.offsetWidth,
          0,
        );
        avgBadgeWidth = totalBadgeWidth / recipientBadges.length;
      }

      // Step 1: Calculate how many can be shown without the +N badge
      let totalWidth = replyLabelWidth;
      let visibleWithoutReserve = 0;

      for (let i = 0; i < recipients.length; i++) {
        const elementWidth = avgBadgeWidth;

        if (totalWidth + elementWidth + gap + padding <= containerWidth) {
          totalWidth += elementWidth + gap;
          visibleWithoutReserve++;
        } else {
          break;
        }
      }

      // If all recipients can fit, no +N badge is needed
      if (visibleWithoutReserve >= recipients.length) {
        setVisibleCount(recipients.length);
        setHiddenCount(0);
        return;
      }

      // Step 2: If not all fit, reserve space for the +N badge and recalculate
      // +N badge requires approximately 40-70px (depends on digit count)
      // Estimates: +1 = ~40px, +10 = ~50px, +100 = ~60px, +1000 = ~70px
      const maxHiddenCount = recipients.length - 1; // Maximum number of hidden items
      const plusBadgeWidth =
        maxHiddenCount < 10 ? 45 : maxHiddenCount < 100 ? 55 : 65;
      const reservedWidth = plusBadgeWidth + gap + padding;

      totalWidth = replyLabelWidth;
      let visible = 0;

      for (let i = 0; i < recipients.length; i++) {
        const elementWidth = avgBadgeWidth;

        // Check if there are more recipients to display
        const hasMoreRecipients = i < recipients.length - 1;
        // If there are more recipients, reserve space for +N badge; otherwise only need padding
        const currentReservedWidth = hasMoreRecipients
          ? reservedWidth
          : padding;

        if (
          totalWidth + elementWidth + gap + currentReservedWidth <=
          containerWidth
        ) {
          totalWidth += elementWidth + gap;
          visible++;
        } else {
          break;
        }
      }

      // Ensure at least one recipient is shown (if there are any)
      const finalVisible = Math.max(1, visible);
      setVisibleCount(finalVisible);
      setHiddenCount(recipients.length - finalVisible);
    };

    // Use requestAnimationFrame to ensure DOM has been rendered
    const rafId = requestAnimationFrame(() => {
      // Delay another frame to ensure all elements have been rendered
      setTimeout(updateVisibleCount, 0);
    });

    // Listen for window resize events
    window.addEventListener("resize", updateVisibleCount);

    // Use ResizeObserver to listen for container width changes
    const resizeObserver = new ResizeObserver(() => {
      updateVisibleCount();
    });

    const container = containerRef.current;
    if (container) {
      resizeObserver.observe(container);
    }

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", updateVisibleCount);
      resizeObserver.disconnect();
    };
  }, [recipients, showReplyLabel, t]);

  const visibleRecipients = recipients.slice(0, visibleCount);
  const hasHidden = hiddenCount > 1; // Only show "+N" badge when hidden count > 1

  /**
   * Open the dropdown
   */
  const handleOpenDropdown = () => {
    setActiveRecipientField(fieldType);
    setShowContactsList(true);
    // After dropdown opens, the search input will automatically get focus
  };

  /**
   * Calculate dropdown position
   * Checks if there is enough space below; if not, displays above
   */
  const calculateDropdownPosition = useCallback((): {
    top: number;
    left: number;
    width: number;
    placement: "bottom" | "top";
  } | null => {
    const container = containerRef.current;
    if (!container) return null;

    const rect = container.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - rect.bottom;
    const spaceAbove = rect.top;
    const dropdownHeight = 192; // max-h-48 = 192px
    const gap = 4; // mt-1 = 4px

    // Check if there is enough space to display below
    const canShowBelow = spaceBelow >= dropdownHeight + gap;
    const canShowAbove = spaceAbove >= dropdownHeight + gap;

    // Prefer displaying below; if not enough space below but there is space above, display above
    const placement: "bottom" | "top" = canShowBelow
      ? "bottom"
      : canShowAbove
        ? "top"
        : "bottom";

    return {
      top:
        placement === "bottom"
          ? rect.bottom + gap
          : rect.top - dropdownHeight - gap,
      left: rect.left,
      width: rect.width,
      placement,
    };
  }, []);

  /**
   * Use useLayoutEffect to synchronously calculate position before browser painting
   * Avoids dropdown flickering
   */
  useLayoutEffect(() => {
    if (!showContactsList || !containerRef.current) {
      setDropdownPosition(null);
      return;
    }

    // Synchronously calculate position
    const position = calculateDropdownPosition();
    setDropdownPosition(position);

    // Listen for scroll and window resize events
    const handleScroll = () => {
      const newPosition = calculateDropdownPosition();
      setDropdownPosition(newPosition);
    };
    const handleResize = () => {
      const newPosition = calculateDropdownPosition();
      setDropdownPosition(newPosition);
    };

    // Use capture mode to listen to all scroll events. Passive flag lets the
    // browser scroll without waiting for the handler — it only reads layout
    // for the dropdown position, never calls preventDefault().
    window.addEventListener("scroll", handleScroll, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("scroll", handleScroll, {
        capture: true,
      } as AddEventListenerOptions);
      window.removeEventListener("resize", handleResize);
    };
  }, [showContactsList, calculateDropdownPosition]);

  /**
   * Handle container click events
   * Opens the dropdown when clicking on the empty area
   */
  const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // If clicking on the container itself (not a child element), open the dropdown
    if (e.target === e.currentTarget) {
      handleOpenDropdown();
      return;
    }

    // If clicking on input, button, or badge, do not handle (these elements have their own handling logic)
    const target = e.target as HTMLElement;
    if (
      target.tagName === "INPUT" ||
      target.closest("button") ||
      target.closest("span[class*='bg-primary/10']")
    ) {
      return;
    }

    // Click on empty area, open the dropdown
    handleOpenDropdown();
  };

  return (
    <div
      className={`flex flex-col relative w-full ${hideLabel ? "" : "gap-1"}`}
    >
      {!hideLabel && (
        <label
          htmlFor={`insight-reply-${fieldType}`}
          className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground/80"
        >
          {label}
        </label>
      )}
      <div
        ref={containerRef}
        onClick={handleContainerClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleContainerClick(
              e as unknown as React.MouseEvent<HTMLDivElement>,
            );
          }
        }}
        className="flex flex-wrap items-center gap-2 h-[36px] overflow-hidden rounded-xl border border-border/50 bg-white/95 pt-1 pb-1 px-2 cursor-text"
      >
        {showReplyLabel && (
          <span
            className="text-xs font-normal shrink-0"
            style={{ color: "rgba(55, 65, 81, 1)" }}
          >
            {t("insight.replyComposeHeading", "Reply")}
          </span>
        )}
        {visibleRecipients.map((recipient) => (
          <span
            key={recipient}
            role="button"
            tabIndex={0}
            className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs text-primary max-w-[100px]"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="truncate flex-1 min-w-0">
              {getRecipientLabel(recipient)}
            </span>
            <button
              type="button"
              className="text-primary/60 transition hover:text-primary shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(recipient);
              }}
            >
              ×
            </button>
          </span>
        ))}

        {hasHidden && (
          <span
            role="button"
            tabIndex={0}
            className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs text-primary shrink-0 cursor-pointer hover:bg-primary/20 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              handleOpenDropdown();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                handleOpenDropdown();
              }
            }}
          >
            +{hiddenCount}
          </span>
        )}
      </div>
      {showContactsList &&
        dropdownPosition &&
        createPortal(
          <div
            ref={contactsListRef as LegacyRef<HTMLDivElement>}
            className="fixed z-[9999] max-h-48 overflow-y-auto rounded-xl border border-border/60 bg-white shadow-lg"
            style={{
              top: `${dropdownPosition.top}px`,
              left: `${dropdownPosition.left}px`,
              width: `${dropdownPosition.width}px`,
            }}
          >
            {/* Selected recipient list */}
            {recipients.length > 0 && (
              <div className="border-b border-border/60 bg-white px-2 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70 mb-1.5">
                  {t("common.selectedRecipients", "Selected")}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {recipients.map((recipient) => (
                    <span
                      key={recipient}
                      className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-xs text-primary max-w-[120px]"
                    >
                      <span className="truncate">
                        {getRecipientLabel(recipient)}
                      </span>
                      <button
                        type="button"
                        className="text-primary/60 transition hover:text-primary shrink-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemove(recipient);
                        }}
                      >
                        <RemixIcon name="close" size="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="border-b px-2 py-1.5 sticky top-0 bg-white z-10">
              <div className="relative">
                <RemixIcon
                  name="search"
                  size="size-3.5"
                  className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60"
                />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t("common.searchContacts")}
                  className="w-full rounded-lg border border-border/40 bg-white px-6 py-1 text-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                  autoFocus
                />
              </div>
            </div>
            {isLoadingContacts ? (
              <div className="flex items-center justify-center gap-2 p-3 text-xs text-muted-foreground">
                <Spinner size={16} />
                {t("common.loadingContacts")}
              </div>
            ) : filteredContacts.length === 0 ? (
              <div className="p-3 text-center text-xs text-muted-foreground">
                {t("common.noContactsFound")}
              </div>
            ) : (
              <ul className="divide-y divide-border/60">
                {filteredContacts.map((contact) => (
                  <li
                    key={contact.id || contact.contactName}
                    className="cursor-pointer bg-white px-2 py-1.5 text-xs hover:bg-primary/5"
                    onClick={() => {
                      onAdd(contact.contactName);
                      setShowContactsList(false);
                      setActiveRecipientField(null);
                    }}
                  >
                    <div className="font-medium text-foreground">
                      {contact.contactName}
                    </div>
                    {contact.contactId && (
                      <div className="text-[10px] text-muted-foreground">
                        {contact.contactId}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
