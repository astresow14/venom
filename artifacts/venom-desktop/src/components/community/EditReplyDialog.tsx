import React, { useEffect, useState } from "react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useUpdateCommunityReply } from "@workspace/api-client-react";
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

const replySchema = z.object({
  body: z.string().min(1, "Reply cannot be empty").max(1000, "Reply too long"),
});

interface EditReplyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  replyId: string;
  threadId: string;
  initialBody: string;
}

export function EditReplyDialog({ open, onOpenChange, replyId, threadId, initialBody }: EditReplyDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm<z.infer<typeof replySchema>>({
    resolver: zodResolver(replySchema),
    defaultValues: {
      body: initialBody,
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({ body: initialBody });
    }
  }, [open, initialBody, form]);

  const updateMutation = useUpdateCommunityReply({
    mutation: {
      onSuccess: (updatedReply) => {
        toast({ title: "Reply updated", description: "Your reply has been updated." });
        onOpenChange(false);
        
        const updater = (old: any) => {
          if (!old || !old.replies) return old;
          return {
            ...old,
            replies: old.replies.map((r: any) => (r.id === replyId ? { ...r, ...updatedReply } : r)),
          };
        };
        
        queryClient.setQueriesData({ queryKey: ["/api/venom/community/threads", threadId] }, updater);
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

  const onSubmit = (data: z.infer<typeof replySchema>) => {
    updateMutation.mutate({ replyId, data });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] border border-border/60 rounded-2xl surface shadow-lift p-0 gap-0">
        <DialogHeader className="p-6 pb-4 border-b border-border/60">
          <DialogTitle className="font-semibold tracking-tight text-xl">
            Edit reply
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
                      placeholder="Enter your reply..."
                      className="resize-none h-24 rounded-md border-border/60 focus-visible:ring-foreground bg-background/50 text-sm"
                      {...field}
                      data-testid="input-edit-reply-body"
                    />
                  </FormControl>
                  <div className="flex justify-between items-center mt-2">
                    <FormMessage className="text-xs font-medium text-destructive" />
                    <span className="text-xs text-muted-foreground ml-auto">
                      {field.value.length}/1000
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
                data-testid="button-submit-edit-reply"
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
