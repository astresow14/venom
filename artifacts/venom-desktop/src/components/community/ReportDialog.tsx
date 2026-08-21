import React, { useState } from "react";
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
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useCreateCommunityReport } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

const reportSchema = z.object({
  reason: z.enum(["spam", "abuse", "harassment", "other"]),
  details: z.string().max(500, "Details must be 500 characters or less").optional(),
});

interface ReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetId: string;
  targetType: "thread" | "reply";
}

export function ReportDialog({ open, onOpenChange, targetId, targetType }: ReportDialogProps) {
  const { toast } = useToast();
  
  const form = useForm<z.infer<typeof reportSchema>>({
    resolver: zodResolver(reportSchema),
    defaultValues: {
      reason: "spam",
      details: "",
    },
  });

  const reportMutation = useCreateCommunityReport({
    mutation: {
      onSuccess: () => {
        toast({ title: "Report submitted", description: "This content has been flagged for review." });
        onOpenChange(false);
        form.reset();
      },
      onError: () => {
        toast({
          title: "Report failed",
          description: "There was a problem submitting your report. Please try again.",
          variant: "destructive",
        });
      },
    }
  });

  const onSubmit = (data: z.infer<typeof reportSchema>) => {
    reportMutation.mutate({
      data: {
        targetId,
        targetType,
        reason: data.reason,
        details: data.details,
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px] border border-border/60 rounded-2xl surface shadow-lift p-0 gap-0">
        <DialogHeader className="p-6 pb-4 border-b border-border/60">
          <DialogTitle className="font-semibold tracking-tight text-xl text-destructive">
            Report {targetType === "thread" ? "thread" : "reply"}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="p-6 pt-4 space-y-5">
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="font-medium text-sm">
                    Reason
                  </FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger className="rounded-md border-border/60 focus:ring-foreground bg-background/50" data-testid="select-report-reason">
                        <SelectValue placeholder="Select a reason" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="rounded-lg border border-border/60 surface shadow-lift">
                      <SelectItem value="spam" className="rounded-md font-medium text-sm">Spam</SelectItem>
                      <SelectItem value="abuse" className="rounded-md font-medium text-sm">Abuse</SelectItem>
                      <SelectItem value="harassment" className="rounded-md font-medium text-sm">Harassment</SelectItem>
                      <SelectItem value="other" className="rounded-md font-medium text-sm">Other</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage className="text-xs font-medium text-destructive" />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="details"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="font-medium text-sm">
                    Details (optional)
                  </FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Additional context..."
                      className="resize-none h-24 rounded-md border-border/60 focus-visible:ring-foreground bg-background/50 text-sm"
                      {...field}
                      data-testid="input-report-details"
                    />
                  </FormControl>
                  <FormMessage className="text-xs font-medium text-destructive" />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                className="rounded-md font-medium text-sm border-border/60"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={reportMutation.isPending}
                className="rounded-md font-medium text-sm bg-destructive text-destructive-foreground hover:bg-destructive/90"
                data-testid="button-submit-report"
              >
                {reportMutation.isPending ? "Submitting..." : "Submit report"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
