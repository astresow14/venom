import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListVenomProjectSops,
  useSelectVenomProjectSops,
  useListVenomSops,
  getListVenomProjectSopsQueryKey,
  getListVenomSopsQueryKey,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, ScrollText, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { asList } from "@/lib/as-list";
import { useToast } from "@/hooks/use-toast";

export default function ProjectSopsDialog({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const {
    data: projectSops,
    isPending: isProjectSopsPending,
    isError: isProjectSopsError,
  } = useListVenomProjectSops(projectId, {
    query: { enabled: open && !!projectId, queryKey: getListVenomProjectSopsQueryKey(projectId) },
  });

  const {
    data: allSopsResponse,
    isPending: isAllSopsPending,
    isError: isAllSopsError,
  } = useListVenomSops(
    { lifecycle: "active" },
    { query: { enabled: open, queryKey: getListVenomSopsQueryKey({ lifecycle: "active" }) } },
  );
  const allSops = asList(allSopsResponse);

  const selectSops = useSelectVenomProjectSops();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Deliberately not `asList`: an unreadable response must leave the existing
    // selection alone rather than clear it.
    if (open && Array.isArray(projectSops)) {
      setSelectedIds(new Set(projectSops.map((selection) => selection.sopId)));
    }
  }, [open, projectSops]);

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
  };

  const handleToggle = (sopId: string) => {
    const next = new Set(selectedIds);
    if (next.has(sopId)) {
      next.delete(sopId);
    } else {
      next.add(sopId);
    }
    setSelectedIds(next);
  };

  const handleSave = () => {
    selectSops.mutate(
      { projectId, data: { sopIds: Array.from(selectedIds) } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListVenomProjectSopsQueryKey(projectId),
          });
          toast({
            title: "SOPs updated",
            description: "The active SOPs for this project have been saved.",
          });
          setOpen(false);
        },
        onError: (err: any) => {
          toast({
            title: "Failed to update SOPs",
            description: err.message || "An error occurred.",
            variant: "destructive",
          });
        },
      },
    );
  };

  // `isPending` rather than `isLoading` so a query that has been enabled but has
  // not yet started still counts as loading, instead of momentarily looking like
  // a settled empty response.
  const isLoading = isProjectSopsPending || isAllSopsPending;

  // Fail closed on anything that is not a readable list. Two distinct failures
  // land here: a rejected query (isError, data undefined) and a request that
  // resolved to the API client's error body instead of throwing (data is a
  // non-array object). Either way we must not render an empty catalog, because
  // "no SOPs exist" invites a Save that submits an empty sopIds list and
  // silently unpins every SOP on the project.
  const isUnreadable =
    (!isProjectSopsPending &&
      (isProjectSopsError || !Array.isArray(projectSops))) ||
    (!isAllSopsPending && (isAllSopsError || !Array.isArray(allSopsResponse)));

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[600px] rounded-2xl border border-border/60 surface p-0 overflow-hidden shadow-lift">
        <div className="p-6">
          <DialogHeader className="mb-6">
            <DialogTitle className="text-xl font-semibold tracking-tight flex items-center gap-2">
              <ScrollText className="h-5 w-5" /> Active Project SOPs
            </DialogTitle>
            <DialogDescription className="text-xs mt-2 text-muted-foreground">
              Pin exact active revisions as reviewable project references
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="flex justify-center p-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : isUnreadable ? (
            <div
              className="flex h-[300px] flex-col items-center justify-center gap-2 rounded-lg border border-destructive/60 bg-destructive/10 p-8 text-center"
              data-testid="text-project-sops-error"
            >
              <p className="text-sm font-medium text-destructive">
                Project SOPs could not be loaded
              </p>
              <p className="text-xs text-destructive/80">
                Close this dialog and try again. Nothing has been changed.
              </p>
            </div>
          ) : (
            <ScrollArea className="h-[300px] border border-border/60 bg-muted/10 p-4">
              {allSops?.length === 0 ? (
                <div className="text-center text-sm text-muted-foreground p-8">
                  No active SOPs available. Create and publish one in the SOP Library.
                </div>
              ) : (
                <div className="space-y-2">
                  {allSops?.map((sop) => {
                    // if it doesn't have an active revision it shouldn't show, but we filtered by active.
                    const isSelected = selectedIds.has(sop.id);
                    return (
                      <label
                        key={sop.id}
                        htmlFor={`project-sop-${sop.id}`}
                        className={cn(
                          "flex items-start space-x-3 border p-3 cursor-pointer transition-colors rounded-lg",
                          isSelected
                            ? "border-foreground bg-foreground/5"
                            : "border-border/60 hover:bg-muted/50",
                        )}
                      >
                        <Checkbox
                          id={`project-sop-${sop.id}`}
                          checked={isSelected}
                          onCheckedChange={() => handleToggle(sop.id)}
                          className="mt-1 rounded-md data-[state=checked]:bg-foreground data-[state=checked]:text-background"
                        />
                        <div>
                          <div className="font-medium text-sm tracking-tight">
                            {sop.title}
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-1">
                            {sop.category.replace("_", " ")} &bull; {sop.content.purpose.slice(0, 80)}
                            {sop.content.purpose.length > 80 ? "..." : ""}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          )}

          <div className="mt-6 flex justify-end gap-3">
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              className="rounded-md font-medium border-border/60"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={selectSops.isPending || isLoading || isUnreadable}
              className="rounded-md font-medium bg-foreground text-background"
            >
              {selectSops.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <CheckCircle2 className="h-4 w-4 mr-2" />
              )}
              Save Selection
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
