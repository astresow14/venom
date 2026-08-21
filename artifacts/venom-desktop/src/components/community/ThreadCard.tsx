import React, { useState } from "react";
import { Link, useLocation } from "wouter";
import { formatDistanceToNow } from "date-fns";
import {
  ThumbsUp,
  MessageSquare,
  Share,
  MoreVertical,
  Trash,
  Edit2,
  Flag,
  Sparkles,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  CommunityThread,
  useVoteCommunityThread,
  useDeleteCommunityThread,
  getGetCommunityBriefingQueryKey,
  getGetCommunityFeedQueryKey,
  getGetCommunityThreadQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useProfileGate } from "@/hooks/use-profile-gate";
import { ReportDialog } from "./ReportDialog";
import { EditThreadDialog } from "./EditThreadDialog";
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

interface ThreadCardProps {
  thread: CommunityThread;
  isDetail?: boolean;
}

export function ThreadCard({ thread, isDetail = false }: ThreadCardProps) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { hasProfile, isLoading } = useProfileGate();

  const [isDeleting, setIsDeleting] = useState(false);
  const [showReportDialog, setShowReportDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const voteMutation = useVoteCommunityThread({
    mutation: {
      onMutate: async ({ threadId, data }) => {
        // Prevent concurrent votes on the same thread
        await queryClient.cancelQueries({ queryKey: ["/api/venom/community"] });

        const updater = (old: any) => {
          if (!old) return old;
          const delta = data.upvoted ? 1 : -1;
          
          if (old.community) {
            return {
              ...old,
              community: old.community.map((t: CommunityThread) =>
                t.id === threadId
                  ? {
                      ...t,
                      viewerHasUpvoted: data.upvoted,
                      score: t.score + delta,
                    }
                  : t
              ),
            };
          }
          if (old.items) {
            return {
              ...old,
              items: old.items.map((t: CommunityThread) =>
                t.id === threadId
                  ? {
                      ...t,
                      viewerHasUpvoted: data.upvoted,
                      score: t.score + delta,
                    }
                  : t
              ),
            };
          }
          if (old.thread && old.thread.id === threadId) {
            return {
              ...old,
              thread: {
                ...old.thread,
                viewerHasUpvoted: data.upvoted,
                score: old.thread.score + delta,
              },
            };
          }
          return old;
        };

        const previousBriefing = queryClient.getQueriesData({
          queryKey: ["/api/venom/community/briefing"],
        });
        const previousFeed = queryClient.getQueriesData({
          queryKey: ["/api/venom/community/feed"],
        });
        const previousThread = queryClient.getQueriesData({
          queryKey: getGetCommunityThreadQueryKey(threadId),
        });

        queryClient.setQueriesData(
          { queryKey: ["/api/venom/community/briefing"] },
          updater
        );
        queryClient.setQueriesData(
          { queryKey: ["/api/venom/community/feed"] },
          updater
        );
        queryClient.setQueriesData(
          { queryKey: getGetCommunityThreadQueryKey(threadId) },
          updater
        );

        return { previousBriefing, previousFeed, previousThread };
      },
      onError: (err, variables, context) => {
        if (context?.previousBriefing) {
          context.previousBriefing.forEach(([k, v]) =>
            queryClient.setQueryData(k, v)
          );
        }
        if (context?.previousFeed) {
          context.previousFeed.forEach(([k, v]) =>
            queryClient.setQueryData(k, v)
          );
        }
        if (context?.previousThread) {
          context.previousThread.forEach(([k, v]) =>
            queryClient.setQueryData(k, v)
          );
        }
        toast({
          title: "Failed to vote",
          description: "There was a problem syncing your vote.",
          variant: "destructive",
        });
      },
      onSuccess: (result) => {
        const updater = (old: any) => {
          if (!old) return old;
          if (old.community) {
            return {
              ...old,
              community: old.community.map((t: CommunityThread) =>
                t.id === result.threadId
                  ? {
                      ...t,
                      score: result.score,
                      viewerHasUpvoted: result.upvoted,
                    }
                  : t
              ),
            };
          }
          if (old.items) {
            return {
              ...old,
              items: old.items.map((t: CommunityThread) =>
                t.id === result.threadId
                  ? {
                      ...t,
                      score: result.score,
                      viewerHasUpvoted: result.upvoted,
                    }
                  : t
              ),
            };
          }
          if (old.thread && old.thread.id === result.threadId) {
            return {
              ...old,
              thread: {
                ...old.thread,
                score: result.score,
                viewerHasUpvoted: result.upvoted,
              },
            };
          }
          return old;
        };
        queryClient.setQueriesData(
          { queryKey: ["/api/venom/community/briefing"] },
          updater
        );
        queryClient.setQueriesData(
          { queryKey: ["/api/venom/community/feed"] },
          updater
        );
        queryClient.setQueriesData(
          { queryKey: getGetCommunityThreadQueryKey(result.threadId) },
          updater
        );
      },
      onSettled: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/venom/community/briefing"] });
        queryClient.invalidateQueries({ queryKey: ["/api/venom/community/feed"] });
        queryClient.invalidateQueries({ queryKey: getGetCommunityThreadQueryKey(thread.id) });
      }
    },
  });

  const deleteMutation = useDeleteCommunityThread({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Thread removed",
          description: "Your thread has been permanently deleted.",
        });
        queryClient.invalidateQueries({
          queryKey: ["/api/venom/community/briefing"],
        });
        queryClient.invalidateQueries({
          queryKey: ["/api/venom/community/feed"],
        });
        if (isDetail) {
          setLocation("/workspace/feed");
        }
      },
      onError: () => {
        setIsDeleting(false);
        toast({
          title: "Delete failed",
          description: "Could not remove the thread at this time.",
          variant: "destructive",
        });
      },
    },
  });

  const performActionIfProfile = (action: () => void) => {
    if (isLoading) return;
    if (!hasProfile) {
      window.dispatchEvent(new Event("open-profile-dialog"));
    } else {
      action();
    }
  };

  const handleVote = (e: React.MouseEvent) => {
    e.preventDefault();
    performActionIfProfile(() => {
      if (voteMutation.isPending) return;
      voteMutation.mutate({
        threadId: thread.id,
        data: { upvoted: !thread.viewerHasUpvoted },
      });
    });
  };

  const handleShare = async (e: React.MouseEvent) => {
    e.preventDefault();
    const url = `${window.location.origin}/workspace/feed/thread/${thread.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast({
        title: "Link copied",
        description: "Direct link copied to clipboard.",
      });
    } catch (err) {
      toast({
        title: "Share failed",
        description: "Could not copy to clipboard. Try copying the URL from your browser.",
        variant: "destructive",
      });
    }
  };

  const handleDelete = () => {
    setIsDeleting(true);
    deleteMutation.mutate({ threadId: thread.id });
  };

  const handleReport = () => {
    performActionIfProfile(() => {
      setShowReportDialog(true);
    });
  };

  const handleEdit = () => {
    performActionIfProfile(() => {
      setShowEditDialog(true);
    });
  };

  return (
    <>
      <article
        className={`group flex flex-col p-5 surface border border-border/60 shadow-soft rounded-xl transition-all duration-300 relative mb-4 ${ isDetail ? "" : "hover:shadow-lift" }`}
        data-testid={`card-thread-${thread.id}`}
        style={{ opacity: isDeleting ? 0.5 : 1 }}
      >
        {!isDetail && (
          <Link
            href={`/workspace/feed/thread/${thread.id}`}
            className="absolute inset-0 z-0"
            aria-label={`View thread by ${thread.author.displayName}`}
          >
            <span className="sr-only">View thread</span>
          </Link>
        )}
        
        {/* Header */}
        <div className="flex items-start justify-between mb-3 relative z-10 pointer-events-none">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 bg-foreground text-background flex items-center justify-center font-semibold rounded-full"
              aria-hidden="true"
            >
              {thread.author.displayName.slice(0, 2)}
            </div>
            <div>
              <div className="font-semibold text-sm text-foreground">
                {thread.author.displayName}
              </div>
              <time
                className="text-xs text-muted-foreground opacity-80"
                dateTime={thread.createdAt}
              >
                {formatDistanceToNow(new Date(thread.createdAt), {
                  addSuffix: true,
                })}
              </time>
            </div>
          </div>
          <div className="flex items-center pointer-events-auto">
            {/* Options Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-md hover:bg-foreground/10 text-muted-foreground hover:text-foreground"
                  aria-label="Thread options menu"
                  data-testid={`button-thread-options-${thread.id}`}
                >
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="rounded-lg border border-border/60 p-1 surface shadow-lift min-w-[160px]"
              >
                {thread.viewerIsAuthor ? (
                  <>
                    <DropdownMenuItem
                      className="rounded-md focus:bg-foreground focus:text-background cursor-pointer font-medium text-xs"
                      onClick={handleEdit}
                      data-testid={`menu-edit-${thread.id}`}
                    >
                      <Edit2 className="w-4 h-4 mr-2" />
                      Edit thread
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="rounded-md focus:bg-destructive focus:text-destructive-foreground cursor-pointer font-medium text-xs"
                      onClick={() => setShowDeleteConfirm(true)}
                      data-testid={`menu-delete-${thread.id}`}
                    >
                      <Trash className="w-4 h-4 mr-2" />
                      Delete thread
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem
                    className="rounded-md focus:bg-foreground focus:text-background cursor-pointer font-medium text-xs"
                    onClick={handleReport}
                    data-testid={`menu-report-${thread.id}`}
                  >
                    <Flag className="w-4 h-4 mr-2" />
                    Report
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Body */}
        <div className="mb-4 relative z-10 pointer-events-none">
          <p className="text-base text-foreground font-medium leading-relaxed whitespace-pre-wrap">
            {thread.body}
          </p>
        </div>

        {/* AI Summary */}
        {thread.summary && thread.summary.status === "generated" && (
          <div className="mb-4 bg-muted/30 border-l border-border/60 rounded-lg p-3 relative z-10 pointer-events-none">
            <div className="flex items-center gap-2 mb-1">
              <Sparkles className="w-3.5 h-3.5 text-foreground" />
              <span className="text-xs font-semibold text-foreground">
                {thread.summary.label || "AI summary"}
              </span>
            </div>
            <p className="text-sm text-muted-foreground italic leading-relaxed">
              "{thread.summary.text}"
            </p>
          </div>
        )}

        {/* Footer / Actions */}
        <div className="flex items-center gap-4 mt-auto pt-2 relative z-10 pointer-events-auto">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleVote}
            disabled={voteMutation.isPending || isLoading}
            data-testid={`button-upvote-${thread.id}`}
            className={`rounded-md px-3 h-8 text-sm font-medium border border-transparent transition-all ${ thread.viewerHasUpvoted ? "bg-foreground text-background hover:bg-foreground/90 hover:text-background" : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground border-transparent hover:border-border" }`}
            aria-label={thread.viewerHasUpvoted ? "Remove upvote" : "Upvote"}
            aria-pressed={thread.viewerHasUpvoted}
          >
            <ThumbsUp
              className={`w-3.5 h-3.5 mr-2 ${ thread.viewerHasUpvoted ? "fill-current" : "" }`}
            />
            {thread.score}
          </Button>

          <div className="flex items-center text-muted-foreground hover:text-foreground transition-colors">
            <Button
              variant="ghost"
              size="sm"
              className="rounded-md px-3 h-8 text-sm font-medium"
              asChild
              data-testid={`link-replies-${thread.id}`}
            >
              {isDetail ? (
                <span className="cursor-default">
                  <MessageSquare className="w-3.5 h-3.5 mr-2" />
                  {thread.replyCount} replies
                </span>
              ) : (
                <Link href={`/workspace/feed/thread/${thread.id}`}>
                  <MessageSquare className="w-3.5 h-3.5 mr-2" />
                  {thread.replyCount} replies
                </Link>
              )}
            </Button>
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={handleShare}
            data-testid={`button-share-${thread.id}`}
            className="rounded-md px-3 h-8 text-sm font-medium ml-auto text-muted-foreground hover:text-foreground"
          >
            <Share className="w-3.5 h-3.5 mr-2" />
            Share
          </Button>
        </div>
      </article>

      {/* Dialogs */}
      <ReportDialog
        open={showReportDialog}
        onOpenChange={setShowReportDialog}
        targetId={thread.id}
        targetType="thread"
      />
      <EditThreadDialog
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
        threadId={thread.id}
        initialBody={thread.body}
      />
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent className="rounded-2xl border border-border/60 surface shadow-lift">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-semibold tracking-tight text-xl">
              Delete this thread?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              This action cannot be undone. It will remove the thread and all replies permanently.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-md font-medium border-border/60">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="rounded-md font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
            >
              Delete thread
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
