import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListSharedWorkspacesQueryKey,
  useCreateSharedWorkspace,
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
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";

/**
 * Creates a shared workspace. The creator becomes the first admin
 * server-side; there is no scope switch to flip — new knowledge reaches the
 * workspace by topic, and its Brain is read through the Brain page filter.
 */
export default function CreateWorkspaceDialog({
  children,
}: {
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createWorkspace = useCreateSharedWorkspace();

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || createWorkspace.isPending) return;

    createWorkspace.mutate(
      { data: { name: trimmed } },
      {
        onSuccess: async (workspace) => {
          await queryClient.invalidateQueries({
            queryKey: getListSharedWorkspacesQueryKey(),
          });
          toast({
            title: "Shared workspace created",
            description: `${workspace.name} is live. Add members to share knowledge and SOPs.`,
          });
          setOpen(false);
          setName("");
        },
        onError: (error: unknown) => {
          const status = (error as { status?: number })?.status;
          toast({
            title: "Could not create workspace",
            description:
              status === 409
                ? "You have reached the shared workspace limit."
                : "Give the workspace a name and try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setName("");
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[440px] rounded-2xl border border-border/60 surface p-0 overflow-hidden shadow-lift">
        <div className="absolute inset-0 bg-gradient-to-br from-foreground/5 to-transparent pointer-events-none" />
        <div className="relative p-6 sm:p-8">
          <DialogHeader className="mb-6">
            <DialogTitle className="text-2xl font-semibold tracking-tight">
              New shared workspace
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground mt-2">
              A space your team shares. Knowledge and SOPs filed here stay on
              the server and are visible to members only.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label
                htmlFor="shared-workspace-name"
                className="mb-2 block text-[10px] font-medium text-muted-foreground"
              >
                Name
              </label>
              <Input
                id="shared-workspace-name"
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Acme Operations"
                autoFocus
                data-testid="input-shared-workspace-name"
                className="rounded-md border-border/60 bg-background/50 text-sm font-medium focus-visible:ring-1 focus-visible:ring-foreground"
              />
            </div>

            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={!name.trim() || createWorkspace.isPending}
                data-testid="button-create-shared-workspace"
                className="rounded-md font-medium px-8"
              >
                {createWorkspace.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Create workspace
              </Button>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
