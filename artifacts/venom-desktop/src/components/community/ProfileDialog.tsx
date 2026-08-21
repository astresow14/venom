import React, { useEffect, useState } from "react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  useGetCommunityProfile,
  useUpsertCommunityProfile,
  getGetCommunityProfileQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { User, AlertCircle } from "lucide-react";

const profileSchema = z.object({
  displayName: z.string().min(1, "Required").max(60, "Too long"),
  bio: z.string().max(300, "Too long").optional().nullable(),
});

export function ProfileDialog() {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    const handleOpen = () => setOpen(true);
    window.addEventListener("open-profile-dialog", handleOpen);
    return () => window.removeEventListener("open-profile-dialog", handleOpen);
  }, []);

  // Load existing profile. Use a staleTime so we don't spam fetch if they keep opening it.
  const { data: profile, isError, error, refetch, isFetching } = useGetCommunityProfile({
    query: {
      queryKey: getGetCommunityProfileQueryKey(),
      enabled: open,
      staleTime: 1000 * 60 * 5,
      retry: (failureCount, error: any) => {
        if (error?.status === 404) return false;
        return failureCount < 2;
      },
    },
  });

  const form = useForm<z.infer<typeof profileSchema>>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      displayName: "",
      bio: "",
    },
  });

  // Re-initialize form when profile is loaded
  useEffect(() => {
    if (profile && open) {
      form.reset({
        displayName: profile.displayName,
        bio: profile.bio || "",
      });
    }
  }, [profile, open, form]);

  const upsertMutation = useUpsertCommunityProfile({
    mutation: {
      onSuccess: (data) => {
        toast({ title: "Profile updated", description: "Your profile has been saved." });
        queryClient.setQueryData(getGetCommunityProfileQueryKey(), data);
        setOpen(false);
      },
      onError: () => {
        toast({
          title: "Update failed",
          description: "Could not save your profile. Try again.",
          variant: "destructive",
        });
      },
    },
  });

  const onSubmit = (data: z.infer<typeof profileSchema>) => {
    upsertMutation.mutate({ data });
  };

  const isNetworkError = isError && (error as any)?.status !== 404;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          className="rounded-md font-medium border-border/60 text-xs h-9 px-4"
          data-testid="button-edit-profile"
        >
          <User className="w-3.5 h-3.5 mr-2" />
          Profile
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[400px] border border-border/60 rounded-2xl surface shadow-lift p-0 gap-0">
        <DialogHeader className="p-6 pb-4 border-b border-border/60">
          <DialogTitle className="font-semibold tracking-tight text-xl">
            Your profile
          </DialogTitle>
        </DialogHeader>

        {isNetworkError ? (
           <div className="p-6 pt-4 flex flex-col items-center justify-center text-center">
             <AlertCircle className="w-8 h-8 text-destructive mb-3" />
             <p className="text-sm mb-4">Could not load profile due to a network error.</p>
             <Button variant="outline" className="rounded-md font-medium" onClick={() => refetch()} disabled={isFetching}>
               {isFetching ? "Retrying..." : "Retry"}
             </Button>
           </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="p-6 pt-4 space-y-5">
              {isError && (error as any)?.status === 404 && (
                <div className="mb-4 bg-muted/50 border border-border/60 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground">
                    Profile required to interact. Please create one now.
                  </p>
                </div>
              )}
              <FormField
                control={form.control}
                name="displayName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-medium text-sm">
                      Display name
                    </FormLabel>
                    <FormControl>
                      <Input
                        className="rounded-md border-border/60 focus-visible:ring-foreground bg-background/50"
                        {...field}
                        data-testid="input-profile-name"
                      />
                    </FormControl>
                    <FormMessage className="text-xs font-medium text-destructive" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="bio"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-medium text-sm">
                      Bio (optional)
                    </FormLabel>
                    <FormControl>
                      <Textarea
                        className="resize-none h-20 rounded-md border-border/60 focus-visible:ring-foreground bg-background/50 text-sm"
                        {...field}
                        value={field.value || ""}
                        data-testid="input-profile-bio"
                      />
                    </FormControl>
                    <FormMessage className="text-xs font-medium text-destructive" />
                  </FormItem>
                )}
              />

              <div className="flex justify-end gap-3 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="rounded-md font-medium text-sm"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={upsertMutation.isPending}
                  className="rounded-md font-medium text-sm"
                  data-testid="button-submit-profile"
                >
                  {upsertMutation.isPending ? "Saving..." : "Save profile"}
                </Button>
              </div>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
