import { useState } from "react";
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
import { useVenomWorkspace } from "@/context/venom-workspace";
import { nextProjectAccent } from "@/lib/projectLifecycle";

/**
 * Creates a personal project from the sidebar and switches straight into it.
 * Creation mirrors the phone's flow (artifacts/venom/app/projects.tsx): the
 * workspace context stamps the fresh id, updatedAt, and default board stages
 * so the project syncs cleanly across devices, the description defaults to
 * the same "Project workspace" copy, and the accent rotates through the same
 * monochrome palette. Switching leaves no session selected, so the new
 * project is immediately ready for its first chat.
 */
export default function CreateProjectDialog({
  idPrefix,
  children,
}: {
  idPrefix: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const { state, addProject, setActiveProject } = useVenomWorkspace();

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setName("");
      setDescription("");
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;

    const id = addProject({
      name: trimmedName,
      description: description.trim() || "Project workspace",
      accent: nextProjectAccent(state.projects.length),
      sourceCount: 0,
    });
    setActiveProject(id);
    handleOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[440px] rounded-2xl border border-border/60 surface p-0 overflow-hidden shadow-lift">
        <div className="absolute inset-0 bg-gradient-to-br from-foreground/5 to-transparent pointer-events-none" />
        <div className="relative p-6 sm:p-8">
          <DialogHeader className="mb-6">
            <DialogTitle className="text-2xl font-semibold tracking-tight">
              New project
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground mt-2">
              A private workspace for one line of work. Its chats, board, and
              captured knowledge stay together on every synced device.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label
                htmlFor={`${idPrefix}-new-project-name`}
                className="mb-2 block text-[10px] font-medium text-muted-foreground"
              >
                Name
              </label>
              <Input
                id={`${idPrefix}-new-project-name`}
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                placeholder="Project name"
                autoFocus
                data-testid={`input-new-project-name-${idPrefix}`}
                className="rounded-md border-border/60 bg-background/50 text-sm font-medium focus-visible:ring-1 focus-visible:ring-foreground"
              />
            </div>

            <div>
              <label
                htmlFor={`${idPrefix}-new-project-description`}
                className="mb-2 block text-[10px] font-medium text-muted-foreground"
              >
                Description
              </label>
              <Input
                id={`${idPrefix}-new-project-description`}
                value={description}
                maxLength={200}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What is this project about? (optional)"
                data-testid={`input-new-project-description-${idPrefix}`}
                className="rounded-md border-border/60 bg-background/50 text-sm font-medium focus-visible:ring-1 focus-visible:ring-foreground"
              />
            </div>

            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={!name.trim()}
                data-testid={`button-create-project-${idPrefix}`}
                className="rounded-md font-medium px-8"
              >
                Create project
              </Button>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
