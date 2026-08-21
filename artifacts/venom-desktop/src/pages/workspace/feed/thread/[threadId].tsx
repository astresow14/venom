import React, { useEffect, useMemo, useState } from "react";
import { useParams, useLocation } from "wouter";
import {
  useGetCommunityThread,
  useCreateCommunityReply,
  useDeleteCommunityReply,
  getGetCommunityThreadQueryKey,
  type CommunityReplyInput,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { ThreadCard } from "@/components/community/ThreadCard";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, MessageSquare, MoreVertical, Trash, Flag, Edit2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useProfileGate } from "@/hooks/use-profile-gate";
import { ReportDialog } from "@/components/community/ReportDialog";
import { EditReplyDialog } from "@/components/community/EditReplyDialog";

export default function ThreadDetailPage() {
  const params = useParams();
  const [, setLocation] = useLocation();
  const threadId = params.threadId!;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { hasProfile, isLoading: profileLoading } = useProfileGate();
  const focusedReplyId = useMemo(
    () => new URLSearchParams(window.location.search).get("replyId"),
    [],
  );

  const { data, isLoading, isError } = useGetCommunityThread(
    threadId,
    focusedReplyId ? { replyId: focusedReplyId } : undefined,
  );

  const [replyBody, setReplyBody] = useState("");
  const [replyRequestId, setReplyRequestId] = useState(() =>
    crypto.randomUUID(),
  );
  const [parentReplyId, setParentReplyId] = useState<string | null>(null);
  const [parentReplyAuthor, setParentReplyAuthor] = useState<string | null>(null);
  
  // Dialog states for replies
  const [reportReplyId, setReportReplyId] = useState<string | null>(null);
  const [editReplyId, setEditReplyId] = useState<string | null>(null);
  const [deleteReplyId, setDeleteReplyId] = useState<string | null>(null);

  useEffect(() => {
    if (!data || !focusedReplyId) return;
    const element = document.getElementById(`reply-${focusedReplyId}`);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.focus({ preventScroll: true });
  }, [data, focusedReplyId]);

  const performActionIfProfile = (action: () => void) => {
    if (profileLoading) return;
    if (!hasProfile) {
      window.dispatchEvent(new Event("open-profile-dialog"));
    } else {
      action();
    }
  };

  const replyMutation = useCreateCommunityReply({
    mutation: {
      onSuccess: () => {
        setReplyBody("");
        setReplyRequestId(crypto.randomUUID());
        setParentReplyId(null);
        setParentReplyAuthor(null);
        toast({ title: "Reply sent", description: "Your reply is now live." });
        queryClient.invalidateQueries({
          queryKey: getGetCommunityThreadQueryKey(threadId),
        });
        queryClient.invalidateQueries({ queryKey: ["/api/venom/community/briefing"] });
        queryClient.invalidateQueries({ queryKey: ["/api/venom/community/feed"] });
      },
      onError: () => {
        toast({
          title: "Failed to reply",
          description: "Something went wrong.",
          variant: "destructive",
        });
      },
    },
  });

  const deleteReplyMutation = useDeleteCommunityReply({
    mutation: {
      onSuccess: () => {
        toast({ title: "Reply deleted", description: "Your reply was removed." });
        queryClient.invalidateQueries({
          queryKey: getGetCommunityThreadQueryKey(threadId),
        });
        queryClient.invalidateQueries({ queryKey: ["/api/venom/community/briefing"] });
        queryClient.invalidateQueries({ queryKey: ["/api/venom/community/feed"] });
        setDeleteReplyId(null);
      },
      onError: () => {
        toast({
          title: "Delete failed",
          description: "Could not remove the reply at this time.",
          variant: "destructive",
        });
        setDeleteReplyId(null);
      },
    },
  });

  const handleReplySubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyBody.trim()) return;
    performActionIfProfile(() => {
      const payload: CommunityReplyInput = {
        body: replyBody,
        clientRequestId: replyRequestId,
      };
      if (parentReplyId) {
        payload.parentReplyId = parentReplyId;
      }
      replyMutation.mutate({ threadId, data: payload });
    });
  };

  const startReplyTo = (replyId: string, authorName: string) => {
    setParentReplyId(replyId);
    setParentReplyAuthor(authorName);
    setReplyRequestId(crypto.randomUUID());

    // Focus the textarea
    const textarea = document.getElementById("reply-input");
    if (textarea) {
      textarea.focus();
    }
  };

  const cancelReplyTo = () => {
    setParentReplyId(null);
    setParentReplyAuthor(null);
    setReplyRequestId(crypto.randomUUID());
  };

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
        <Skeleton className="w-32 h-6 mb-8 rounded-md" />
        <Skeleton className="w-full h-40 mb-8 rounded-md" />
        <Skeleton className="w-full h-24 mb-4 rounded-md" />
        <Skeleton className="w-full h-24 rounded-md" />
      </div>
    );
  }

  // A failed request resolves to the error body instead of throwing, so `data`
  // can be a truthy `{ error }` object that slips past a plain `!data` check and
  // then crashes on `data.thread` / `data.replies`. Treat any payload that is
  // not the expected shape as a load failure.
  const isMalformed =
    !data || !data.thread || !Array.isArray(data.replies);

  if (isError || isMalformed) {
    return (
      <div className="p-4 md:p-8 max-w-4xl mx-auto w-full text-center">
        <div className="border border-destructive/60 p-8 rounded-2xl bg-destructive/10 inline-block shadow-soft">
          <h2 className="text-xl font-semibold tracking-tight text-destructive mb-2">
            Thread Not Found
          </h2>
          <p className="text-sm text-destructive/80 mb-6">
            This thread is no longer available or could not be found.
          </p>
          <Button onClick={() => setLocation("/workspace/feed")} variant="outline" className="rounded-md border-destructive/60 text-destructive hover:bg-destructive hover:text-destructive-foreground">
            Return to Briefing
          </Button>
        </div>
      </div>
    );
  }

  const editReplyData = editReplyId ? data.replies.find(r => r.id === editReplyId) : null;

  return (
    <div className="flex-1 overflow-y-auto bg-background p-4 md:p-8 relative scroll-smooth">
      <div className="max-w-4xl mx-auto pb-24">
        {/* Nav Back */}
        <div className="mb-6">
          <Button
            variant="ghost"
            onClick={() => setLocation("/workspace/feed")}
            className="rounded-md text-sm font-medium px-4"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Briefing
          </Button>
        </div>

        {/* Thread Component */}
        <div className="mb-10">
          <ThreadCard thread={data.thread} isDetail />
        </div>

        {/* Replies Section */}
        <section>
          <div className="flex items-center gap-3 mb-6 border-b border-border pb-2">
            <MessageSquare className="w-5 h-5 text-muted-foreground" />
            <h3 className="font-semibold text-sm text-foreground">
              {data.replies.length} Replies
            </h3>
          </div>

          {/* New Reply Form */}
          <form onSubmit={handleReplySubmit} className="mb-10 p-5 surface border border-border/60 rounded-xl shadow-soft">
            {parentReplyId && (
              <div className="flex items-center justify-between mb-3 p-2 bg-muted/50 border border-border/60 rounded-md text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Replying to:</span>
                  <span className="font-semibold text-foreground">{parentReplyAuthor}</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={cancelReplyTo}
                  className="h-6 px-2 rounded-sm hover:bg-destructive/20 hover:text-destructive"
                  data-testid="button-cancel-reply-target"
                >
                  Cancel
                </Button>
              </div>
            )}
            <label htmlFor="reply-input" className="sr-only">Your reply</label>
            <Textarea
              id="reply-input"
              placeholder="Write a reply..."
              className="resize-none h-24 mb-3 rounded-md border-border/60 bg-background/50 text-sm"
              value={replyBody}
              onChange={(e) => {
                setReplyBody(e.target.value);
                setReplyRequestId(crypto.randomUUID());
              }}
              disabled={replyMutation.isPending}
              data-testid="input-reply-body"
            />
            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={!replyBody.trim() || replyMutation.isPending}
                className="rounded-md font-medium px-6"
                data-testid="button-submit-reply"
              >
                {replyMutation.isPending ? "Sending..." : "Reply"}
              </Button>
            </div>
          </form>

          {/* Replies List */}
          <div className="space-y-4">
            {data.replies.map((reply) => (
              <div
                key={reply.id}
                id={`reply-${reply.id}`}
                tabIndex={-1}
                aria-label={
                  focusedReplyId === reply.id
                    ? `Opened reply from ${reply.author.displayName}`
                    : undefined
                }
                className={cn(
                  "flex flex-col p-4 border rounded-xl bg-background shadow-soft transition-opacity outline-none",
                  focusedReplyId === reply.id
                    ? "border-foreground ring-2 ring-foreground ring-offset-2 ring-offset-background"
                    : "border-border/60",
                )}
                style={{ opacity: deleteReplyId === reply.id ? 0.5 : 1 }}
                data-testid={`card-reply-${reply.id}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm text-foreground">
                      {reply.author.displayName}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(reply.createdAt), {
                        addSuffix: true,
                      })}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => startReplyTo(reply.id, reply.author.displayName)}
                      className="h-6 px-2 text-xs font-medium rounded-md text-muted-foreground"
                      data-testid={`button-reply-to-${reply.id}`}
                    >
                      Reply
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                          aria-label="Reply options menu"
                        >
                          <MoreVertical className="h-3 w-3" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="rounded-lg border border-border/60 p-1 surface shadow-lift min-w-[120px]"
                      >
                        {reply.viewerIsAuthor ? (
                          <>
                            <DropdownMenuItem
                              className="rounded-md text-sm cursor-pointer"
                              onClick={() => performActionIfProfile(() => setEditReplyId(reply.id))}
                            >
                              <Edit2 className="w-3 h-3 mr-2" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="rounded-md text-sm cursor-pointer focus:bg-destructive focus:text-destructive-foreground"
                              onClick={() => setDeleteReplyId(reply.id)}
                            >
                              <Trash className="w-3 h-3 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </>
                        ) : (
                          <DropdownMenuItem
                            className="rounded-md text-sm cursor-pointer"
                            onClick={() => performActionIfProfile(() => setReportReplyId(reply.id))}
                          >
                            <Flag className="w-3 h-3 mr-2" />
                            Report
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                  {reply.body}
                </p>
                {reply.parentReplyId && (
                  <div className="mt-3 p-3 bg-muted/20 border-l border-muted-foreground/30 rounded-md text-xs text-muted-foreground">
                    <span className="text-xs mb-1 block text-muted-foreground font-medium">In response to</span>
                    <p className="line-clamp-2 italic">
                      {data.replies.find(r => r.id === reply.parentReplyId)?.body || "Original message unavailable"}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Dialogs */}
      {reportReplyId && (
        <ReportDialog
          open={!!reportReplyId}
          onOpenChange={(open) => !open && setReportReplyId(null)}
          targetId={reportReplyId}
          targetType="reply"
        />
      )}
      
      {editReplyData && (
        <EditReplyDialog
          open={!!editReplyId}
          onOpenChange={(open) => !open && setEditReplyId(null)}
          replyId={editReplyData.id}
          threadId={threadId}
          initialBody={editReplyData.body}
        />
      )}

      <AlertDialog open={!!deleteReplyId} onOpenChange={(open) => !open && setDeleteReplyId(null)}>
        <AlertDialogContent className="rounded-2xl border border-border/60 surface shadow-lift">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-semibold tracking-tight text-xl">
              Erase Reply?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              This action cannot be undone. It will remove your reply permanently.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-md font-medium border-border/60">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="rounded-md font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteReplyId && deleteReplyMutation.mutate({ replyId: deleteReplyId })}
            >
              Delete reply
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
