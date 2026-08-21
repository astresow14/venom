import { useGetCommunityProfile, getGetCommunityProfileQueryKey } from "@workspace/api-client-react";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useProfileGate() {
  const queryClient = useQueryClient();
  const [profileMissing, setProfileMissing] = useState(false);

  const query = useGetCommunityProfile({
    query: {
      queryKey: getGetCommunityProfileQueryKey(),
      retry: (failureCount, error: any) => {
        if (error?.status === 404) return false;
        return failureCount < 2;
      },
      staleTime: 1000 * 60 * 5,
    }
  });

  useEffect(() => {
    if (query.isError) {
      const err = query.error as any;
      if (err?.status === 404) {
        setProfileMissing(true);
      }
    } else if (query.data) {
      setProfileMissing(false);
    }
  }, [query.isError, query.error, query.data]);

  const checkProfile = () => {
    if (profileMissing || (query.isError && (query.error as any)?.status === 404)) {
      return false; // missing
    }
    return true; // has profile or loading/other error
  };

  return {
    hasProfile: checkProfile(),
    isLoading: query.isLoading,
    isError: query.isError && (query.error as any)?.status !== 404,
  };
}
