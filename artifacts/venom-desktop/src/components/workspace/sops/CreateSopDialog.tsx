import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateVenomSop,
  useCreateSharedWorkspaceSop,
  getListVenomSopsQueryKey,
  getListSharedWorkspaceSopsQueryKey,
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
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";

const formSchema = z.object({
  title: z.string().min(1, "Title is required").max(160),
  category: z.enum(["operations", "brand", "customer_service"]),
  provenance: z.enum(["manual", "imported", "model_assisted"]),
});

type FormValues = z.infer<typeof formSchema>;

export default function CreateSopDialog({
  children,
  workspace,
}: {
  children: React.ReactNode;
  /**
   * When set, the SOP is created in this shared workspace through the
   * membership-checked endpoint instead of the personal store.
   */
  workspace?: { id: string; name: string };
}) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title: "",
      category: "operations",
      provenance: "manual",
    },
  });

  const createSop = useCreateVenomSop();
  const createWorkspaceSop = useCreateSharedWorkspaceSop();
  const isPending = createSop.isPending || createWorkspaceSop.isPending;

  const onSubmit = (data: FormValues) => {
    const body = {
      title: data.title,
      category: data.category,
      tags: [],
      provenance: data.provenance,
      content: {
        purpose: "Describe the purpose of this SOP.",
        prerequisites: [],
        inputs: [],
        guidance: ["Enter step-by-step guidance here."],
        requiredApprovals: [],
        acceptanceChecks: [],
      },
    };

    const callbacks = {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: workspace
            ? getListSharedWorkspaceSopsQueryKey(workspace.id)
            : getListVenomSopsQueryKey(),
        });
        toast({
          title: "SOP created",
          description: workspace
            ? `A new draft SOP has been created in ${workspace.name}.`
            : "A new draft SOP has been created.",
        });
        setOpen(false);
        form.reset();
      },
      onError: (err: any) => {
        toast({
          title: "Failed to create SOP",
          description: err.message || "Please check your inputs and try again.",
          variant: "destructive",
        });
      },
    };

    if (workspace) {
      createWorkspaceSop.mutate(
        { workspaceId: workspace.id, data: body },
        callbacks,
      );
    } else {
      createSop.mutate({ data: body }, callbacks);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[500px] rounded-2xl border border-border/60 surface p-0 overflow-hidden shadow-lift">
        <div className="absolute inset-0 bg-gradient-to-br from-foreground/5 to-transparent pointer-events-none" />
        <div className="relative p-6 sm:p-8">
          <DialogHeader className="mb-6">
            <DialogTitle className="text-2xl font-semibold tracking-tight">
              Create SOP
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground mt-2">
              {workspace
                ? `Start a new procedure shared with everyone in ${workspace.name}`
                : "Start a new standard operating procedure"}
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-[10px]">
                      Title
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g. INCIDENT RESPONSE"
                        className="rounded-md border-border/60 bg-background/50 text-sm font-medium focus-visible:ring-1 focus-visible:ring-foreground"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage className="text-[10px]" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="provenance"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-[10px]">
                      Content source
                    </FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                    >
                      <FormControl>
                        <SelectTrigger className="rounded-md border-border/60 bg-background/50 font-medium focus-visible:ring-1 focus-visible:ring-foreground">
                          <SelectValue placeholder="Select content source" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="rounded-lg border-border/60 bg-background shadow-lift">
                        <SelectItem value="manual">Written manually</SelectItem>
                        <SelectItem value="imported">Imported text</SelectItem>
                        <SelectItem value="model_assisted">
                          Model-assisted
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-[10px] leading-relaxed text-muted-foreground">
                      Imported and model-assisted text is stored as untrusted
                      reference material. Review it before publishing.
                    </p>
                    <FormMessage className="text-[10px]" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-[10px]">
                      Category
                    </FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                    >
                      <FormControl>
                        <SelectTrigger className="rounded-md border-border/60 bg-background/50 font-medium focus-visible:ring-1 focus-visible:ring-foreground">
                          <SelectValue placeholder="Select a category" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="rounded-lg border-border/60 bg-background shadow-lift">
                        <SelectItem value="operations" className="font-medium text-xs rounded-md">Operations</SelectItem>
                        <SelectItem value="brand" className="font-medium text-xs rounded-md">Brand</SelectItem>
                        <SelectItem value="customer_service" className="font-medium text-xs rounded-md">Customer Service</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage className="text-[10px]" />
                  </FormItem>
                )}
              />

              <div className="pt-4 flex justify-end">
                <Button
                  type="submit"
                  disabled={isPending}
                  className="rounded-md font-medium px-8"
                >
                  {isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    "Initialize Draft"
                  )}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
