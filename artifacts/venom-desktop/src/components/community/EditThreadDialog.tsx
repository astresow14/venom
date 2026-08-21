import React, { useEffect, useState } from "react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useUpdateCommunityThread } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Edit2 } from "lucide-react";

const threadSchema = z.object({
  body: z.string().min(1, "Message cannot be empty").max(2000, "Message too long"),
});

interface EditThreadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threadId: string;
  initialBody: string;
}

export function EditThreadDialog({ open, onOpenChange, threadId, initialBody }: EditThreadDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm<z.infer<typeof threadSchema>>({
    resolver: zodResolver(threadSchema),
    defaultValues: {
      body: initialBody,
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({ body: initialBody });
    }
  }, [open, initialBody, form]);

  const updateMutation = useUpdateCommunityThread({
    mutation: {
      onSuccess: (updatedThread) => {
        toast({ title: "Thread updated", description: "Your message has been updated." });
        onOpenChange(false);
        
        // Update queries in place
        const updater = (old: any) => {
          if (!old) return old;
          if (old.community) {
            return {
              ...old,
              community: old.community.map((t: any) => (t.id === threadId ? { ...t, ...updatedThread } : t)),
            };
          }
          if (old.items) {
            return {
              ...old,
              items: old.items.map((t: any) => (t.id === threadId ? { ...t, ...updatedThread } : t)),
            };
          }
          if (old.thread && old.thread.id === threadId) {
            return {
              ...old,
              thread: { ...old.thread, ...updatedThread },
            };
          }
          return old;
        };
        
        queryClient.setQueriesData({ queryKey: ["/api/venom/community/briefing"] }, updater);
        queryClient.setQueriesData({ queryKey: ["/api/venom/community/feed"] }, updater);
        queryClient.setQueriesData({ queryKey: ["/api/venom/community/threads"] }, updater);
      },
      onError: () => {
        toast({
          title: "Failed to update",
          description: "Something went wrong. Try again.",
          variant: "destructive",
        });
      },
    },
  });

  const onSubmit = (data: z.infer<typeof threadSchema>) => {
    updateMutation.mutate({ threadId, data });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] border border-border/60 rounded-2xl surface shadow-lift p-0 gap-0">
        <DialogHeader className="p-6 pb-4 border-b border-border/60">
          <DialogTitle className="font-semibold tracking-tight text-xl">
            Edit broadcast
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="p-6 pt-4 space-y-6">
            <FormField
              control={form.control}
              name="body"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Textarea
                      placeholder="Enter your message..."
                      className="resize-none h-32 rounded-md border-border/60 focus-visible:ring-foreground bg-background/50 text-sm"
                      {...field}
                      data-testid="input-edit-thread-body"
                    />
                  </FormControl>
                  <div className="flex justify-between items-center mt-2">
                    <FormMessage className="text-xs font-medium text-destructive" />
                    <span className="text-xs text-muted-foreground ml-auto">
                      {field.value.length}/2000
                    </span>
                  </div>
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                className="rounded-md font-medium border-border/60"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={updateMutation.isPending}
                className="rounded-md font-medium"
                data-testid="button-submit-edit-thread"
              >
                {updateMutation.isPending ? "Saving..." : "Save changes"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
