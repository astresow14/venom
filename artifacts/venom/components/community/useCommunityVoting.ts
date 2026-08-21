import { useCallback } from "react";
import { useQueryClient, QueryKey, InfiniteData } from "@tanstack/react-query";
import {
  useVoteCommunityThread,
  getGetCommunityThreadQueryKey,
  CommunityBriefingPage,
  CommunityThreadDetail,
} from "@workspace/api-client-react";

interface OptimisticVotingContext {
  briefingQueries: [QueryKey, InfiniteData<CommunityBriefingPage> | undefined][];
  oldDetailData: CommunityThreadDetail | undefined;
  threadDetailKey: QueryKey;
}

export function useCommunityVoting() {
  const queryClient = useQueryClient();
  const voteMutation = useVoteCommunityThread<Error, OptimisticVotingContext>({
    mutation: {
      onMutate: async ({ threadId, data: { upvoted } }) => {
        // Cancel queries
        await queryClient.cancelQueries({ queryKey: ["/api/venom/community/briefing"] });
        await queryClient.cancelQueries({ queryKey: getGetCommunityThreadQueryKey(threadId) });

        // Optimistically update briefing pages
        const briefingQueries = queryClient.getQueriesData<InfiniteData<CommunityBriefingPage>>({
          queryKey: ["/api/venom/community/briefing"],
        });

        // We don't know the exact new score yet (the server determines it), 
        // but optimistically we just increment or decrement based on current state in cache
        briefingQueries.forEach(([queryKey, oldData]) => {
          if (oldData) {
            queryClient.setQueryData<InfiniteData<CommunityBriefingPage>>(queryKey, {
              ...oldData,
              pages: oldData.pages.map((page) => ({
                ...page,
                community: page.community.map((thread) => {
                  if (thread.id === threadId) {
                    const delta = upvoted ? 1 : -1;
                    return {
                      ...thread,
                      viewerHasUpvoted: upvoted,
                      score: Math.max(0, thread.score + delta),
                    };
                  }
                  return thread;
                }),
              })),
            });
          }
        });

        // Optimistically update thread detail
        const threadDetailKey = getGetCommunityThreadQueryKey(threadId);
        const oldDetailData = queryClient.getQueryData<CommunityThreadDetail>(threadDetailKey);
        
        if (oldDetailData) {
          queryClient.setQueryData<CommunityThreadDetail>(threadDetailKey, {
            ...oldDetailData,
            thread: {
              ...oldDetailData.thread,
              viewerHasUpvoted: upvoted,
              score: Math.max(0, oldDetailData.thread.score + (upvoted ? 1 : -1)),
            },
          });
        }

        return { briefingQueries, oldDetailData, threadDetailKey };
      },
      onError: (err, variables, context) => {
        if (context?.briefingQueries) {
          context.briefingQueries.forEach(([queryKey, oldData]) => {
            queryClient.setQueryData(queryKey, oldData);
          });
        }
        if (context?.oldDetailData && context?.threadDetailKey) {
          queryClient.setQueryData(context.threadDetailKey, context.oldDetailData);
        }
      },
      onSuccess: (result, variables, context) => {
        // Replace with server result
        const briefingQueries = queryClient.getQueriesData<InfiniteData<CommunityBriefingPage>>({
          queryKey: ["/api/venom/community/briefing"],
        });

        briefingQueries.forEach(([queryKey, oldData]) => {
          if (oldData) {
            queryClient.setQueryData<InfiniteData<CommunityBriefingPage>>(queryKey, {
              ...oldData,
              pages: oldData.pages.map((page) => ({
                ...page,
                community: page.community.map((thread) =>
                  thread.id === variables.threadId
                    ? {
                        ...thread,
                        viewerHasUpvoted: result.upvoted,
                        score: result.score,
                      }
                    : thread
                ),
              })),
            });
          }
        });

        if (context?.threadDetailKey) {
          const currentDetail = queryClient.getQueryData<CommunityThreadDetail>(context.threadDetailKey);
          if (currentDetail) {
            queryClient.setQueryData<CommunityThreadDetail>(context.threadDetailKey, {
              ...currentDetail,
              thread: {
                ...currentDetail.thread,
                viewerHasUpvoted: result.upvoted,
                score: result.score,
              },
            });
          }
        }
      },
    },
  });

  const toggleVote = useCallback(
    (threadId: string, currentlyUpvoted: boolean) => {
      voteMutation.mutate({ threadId, data: { upvoted: !currentlyUpvoted } });
    },
    [voteMutation]
  );

  const isPending = useCallback(
    (threadId: string) => {
      return voteMutation.variables?.threadId === threadId && voteMutation.isPending;
    },
    [voteMutation.variables?.threadId, voteMutation.isPending]
  );

  return { toggleVote, isPending };
}