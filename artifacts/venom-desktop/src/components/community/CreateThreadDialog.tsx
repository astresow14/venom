import React, { useState } from "react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useCreateCommunityThread } from "@workspace/api-client-react";
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
  FormMessage,
} from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Send } from "lucide-react";
import { useProfileGate } from "@/hooks/use-profile-gate";

const threadSchema = z.object({
  body: z.string().min(1, "Message cannot be empty").max(2000, "Message too long"),
});

export function CreateThreadDialog() {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { hasProfile, isLoading } = useProfileGate();

  const form = useForm<z.infer<typeof threadSchema>>({
    resolver: zodResolver(threadSchema),
    defaultValues: {
      body: "",
    },
  });

  const createMutation = useCreateCommunityThread({
    mutation: {
      onSuccess: () => {
        toast({ title: "Thread published", description: "Your message is live." });
        setOpen(false);
        form.reset();
        // Invalidate both briefing and feed to show the new thread immediately
        queryClient.invalidateQueries({ queryKey: ["/api/venom/community/briefing"] });
        queryClient.invalidateQueries({ queryKey: ["/api/venom/community/feed"] });
      },
      onError: () => {
        toast({
          title: "Failed to publish",
          description: "Something went wrong. Try again.",
          variant: "destructive",
        });
      },
    },
  });

  const onSubmit = (data: z.infer<typeof threadSchema>) => {
    createMutation.mutate({ data });
  };

  const handleOpenClick = (e: React.MouseEvent) => {
    if (isLoading) {
      e.preventDefault();
      return;
    }
    if (!hasProfile) {
      e.preventDefault();
      window.dispatchEvent(new Event("open-profile-dialog"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          className="rounded-md font-medium px-6"
          data-testid="button-new-thread"
          onClick={handleOpenClick}
          disabled={isLoading}
        >
          <Send className="w-4 h-4 mr-2" />
          Broadcast
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px] border border-border/60 rounded-2xl surface shadow-lift p-0 gap-0">
        <DialogHeader className="p-6 pb-4 border-b border-border/60">
          <DialogTitle className="font-semibold tracking-tight text-xl">
            New broadcast
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
                      data-testid="input-thread-body"
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
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={createMutation.isPending}
                className="rounded-md font-medium"
                data-testid="button-submit-thread"
              >
                {createMutation.isPending ? "Broadcasting..." : "Publish"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
