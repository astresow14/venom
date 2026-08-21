import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateVenomApp,
  getListVenomAppsQueryKey,
  type VenomAppInput,
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus } from "lucide-react";

const formSchema = z.object({
  name: z.string().min(1, "Name is required").max(120),
  brand: z.string().min(1, "Brand is required").max(120),
  purpose: z.string().min(1, "Purpose is required").max(1000),
  deploymentUrl: z
    .string()
    .max(2048)
    .refine(
      (value) =>
        !value ||
        (() => {
          try {
            const url = new URL(value);
            return (
              (url.protocol === "https:" || url.protocol === "http:") &&
              !url.username &&
              !url.password
            );
          } catch {
            return false;
          }
        })(),
      "Use a valid HTTP or HTTPS URL",
    ),
});

type FormValues = z.infer<typeof formSchema>;

export default function CreateAppDialog({
  children,
}: {
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      brand: "",
      purpose: "",
      deploymentUrl: "",
    },
  });

  const createApp = useCreateVenomApp();

  const onSubmit = (data: FormValues) => {
    createApp.mutate(
      {
        data: {
          ...data,
          deploymentUrl: data.deploymentUrl || null,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListVenomAppsQueryKey(),
          });
          toast({
            title: "App created",
            description: "Your portfolio app record is ready.",
          });
          setOpen(false);
          form.reset();
        },
        onError: (err) => {
          toast({
            title: "Failed to create app",
            description: "Please check your inputs and try again.",
            variant: "destructive",
          });
          console.error(err);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[500px] rounded-2xl border-border/60 surface p-0 overflow-hidden shadow-lift">
        <div className="absolute inset-0 bg-gradient-to-br from-foreground/5 to-transparent pointer-events-none" />
        <div className="relative p-6 sm:p-8 sheen">
          <DialogHeader className="mb-6">
            <DialogTitle className="text-2xl font-semibold tracking-tight">
              Register app
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground mt-2">
              Add a product to your portfolio
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-sm font-medium">
                      App name
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Nexus Controller"
                        className="rounded-md border-border/60 bg-background/50 text-sm focus-visible:ring-ring shadow-soft"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="deploymentUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-sm font-medium">
                      Existing deployment URL
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="url"
                        placeholder="https://example.com"
                        autoCapitalize="none"
                        autoCorrect="off"
                        className="rounded-md border-border/60 bg-background/50 text-sm focus-visible:ring-ring shadow-soft"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription className="text-xs text-muted-foreground">
                      Optional. Venom will link to it, not deploy it.
                    </FormDescription>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="brand"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-sm font-medium">
                      Brand / identity
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Acme Corp"
                        className="rounded-md border-border/60 bg-background/50 text-sm focus-visible:ring-ring shadow-soft"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="purpose"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-sm font-medium">
                      Primary purpose
                    </FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="State purpose of this application..."
                        className="min-h-[100px] resize-none rounded-md border-border/60 bg-background/50 text-sm focus-visible:ring-ring shadow-soft"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />

              <div className="pt-4 flex justify-end">
                <Button
                  type="submit"
                  disabled={createApp.isPending}
                  className="rounded-md font-medium px-8 shadow-soft"
                  data-testid="button-submit-create-app"
                >
                  {createApp.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    "Create app"
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
