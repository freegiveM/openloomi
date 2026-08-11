/**
 * Skeleton for Chat Panel - matches the actual chat layout structure
 * Includes: message bubbles (AI and user), and input area placeholder
 */
export function ChatSkeleton() {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Chat messages area */}
      <div className="flex-1 min-h-0 w-full overflow-y-auto px-4 pt-4 pb-4">
        <div className="mx-auto w-full max-w-3xl min-w-0 space-y-4">
          {/* AI message bubble */}
          <div className="flex gap-3">
            <div className="shrink-0 size-8 rounded-full bg-muted/60 animate-pulse" />
            <div className="flex-1 min-w-0 space-y-2">
              <div
                className="h-4 bg-muted/60 rounded animate-pulse"
                style={{ width: "60%" }}
              />
              <div
                className="h-4 bg-muted/40 rounded animate-pulse"
                style={{ width: "80%" }}
              />
              <div
                className="h-4 bg-muted/40 rounded animate-pulse"
                style={{ width: "40%" }}
              />
            </div>
          </div>

          {/* User message bubble */}
          <div className="flex gap-3 justify-end">
            <div className="flex-1 min-w-0 space-y-2 flex flex-col items-end">
              <div
                className="h-10 bg-muted/60 rounded-2xl animate-pulse"
                style={{ width: "50%" }}
              />
            </div>
          </div>

          {/* AI message bubble 2 */}
          <div className="flex gap-3">
            <div className="shrink-0 size-8 rounded-full bg-muted/60 animate-pulse" />
            <div className="flex-1 min-w-0 space-y-2">
              <div
                className="h-4 bg-muted/60 rounded animate-pulse"
                style={{ width: "70%" }}
              />
              <div
                className="h-4 bg-muted/40 rounded animate-pulse"
                style={{ width: "50%" }}
              />
            </div>
          </div>

          {/* Loading indicator */}
          <div className="flex items-center gap-2 justify-center py-2">
            <div className="size-4 bg-muted/60 rounded-full animate-pulse" />
            <div className="h-4 w-20 bg-muted/60 rounded animate-pulse" />
          </div>
        </div>
      </div>

      {/* Input area placeholder */}
      <div className="shrink-0 px-4 pb-4">
        <div className="mx-auto w-full max-w-3xl">
          <div className="flex items-center gap-2 p-3 rounded-2xl border bg-muted/20 animate-pulse">
            <div className="h-8 w-8 rounded-full bg-muted/40 animate-pulse" />
            <div className="flex-1 h-8 bg-muted/40 rounded-full animate-pulse" />
            <div className="h-8 w-8 rounded-full bg-muted/40 animate-pulse" />
          </div>
        </div>
      </div>
    </div>
  );
}
