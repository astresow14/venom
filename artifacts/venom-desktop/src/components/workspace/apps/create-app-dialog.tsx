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
      <DialogContent className="sm:max-w-[500px] rounded-none border-border bg-background/95 backdrop-blur-3xl p-0 overflow-hidden shadow-2xl">
        <div className="absolute inset-0 bg-gradient-to-br from-foreground/5 to-transparent pointer-events-none" />
        <div className="relative p-6 sm:p-8">
          <DialogHeader className="mb-6">
            <DialogTitle className="text-2xl font-black uppercase tracking-tighter">
              Register App
            </DialogTitle>
            <DialogDescription className="font-mono text-xs uppercase tracking-widest text-muted-foreground mt-2">
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
                    <FormLabel className="font-mono text-[10px] uppercase tracking-widest">
                      App Name
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="NEXUS CONTROLLER"
                        className="rounded-none border-border/50 bg-background/50 text-sm font-bold uppercase focus-visible:ring-1 focus-visible:ring-foreground"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage className="text-[10px] uppercase tracking-wider" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="deploymentUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-mono text-[10px] uppercase tracking-widest">
                      Existing deployment URL
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="url"
                        placeholder="https://example.com"
                        autoCapitalize="none"
                        autoCorrect="off"
                        className="rounded-none border-border/50 bg-background/50 text-sm focus-visible:ring-1 focus-visible:ring-foreground"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription className="text-[10px]">
                      Optional. Venom will link to it, not deploy it.
                    </FormDescription>
                    <FormMessage className="text-[10px] uppercase tracking-wider" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="brand"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-mono text-[10px] uppercase tracking-widest">
                      Brand / Identity
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="ACME CORP"
                        className="rounded-none border-border/50 bg-background/50 text-sm font-bold uppercase focus-visible:ring-1 focus-visible:ring-foreground"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage className="text-[10px] uppercase tracking-wider" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="purpose"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-mono text-[10px] uppercase tracking-widest">
                      Primary Purpose
                    </FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="State purpose of this application..."
                        className="min-h-[100px] resize-none rounded-none border-border/50 bg-background/50 text-sm font-medium focus-visible:ring-1 focus-visible:ring-foreground"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage className="text-[10px] uppercase tracking-wider" />
                  </FormItem>
                )}
              />

              <div className="pt-4 flex justify-end">
                <Button
                  type="submit"
                  disabled={createApp.isPending}
                  className="rounded-none font-bold uppercase tracking-widest px-8"
                  data-testid="button-submit-create-app"
                >
                  {createApp.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    "Initialize"
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
