import { useState, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateVenomAppImport,
  useCompleteVenomAppImportUpload,
  useRetryVenomAppImport,
  getGetVenomAppQueryKey,
  getListVenomAppsQueryKey,
  type VenomImportUploadTicket,
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
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { UploadCloud, FileArchive, X, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export default function UploadVersionDialog({
  appId,
  retryJobId,
  retryFilename,
  retryDeclaredBytes,
  children,
}: {
  appId: string;
  retryJobId?: string;
  retryFilename?: string;
  retryDeclaredBytes?: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploadState, setUploadState] = useState<
    "idle" | "creating_job" | "uploading" | "completing" | "success" | "error"
  >("idle");
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createImport = useCreateVenomAppImport();
  const retryImport = useRetryVenomAppImport();
  const completeImport = useCompleteVenomAppImportUpload();
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const ticketRef = useRef<VenomImportUploadTicket | null>(null);

  useEffect(() => {
    if (!open) {
      if (xhrRef.current) {
        xhrRef.current.abort();
      }
      setFile(null);
      setUploadState("idle");
      setProgress(0);
      setErrorMsg(null);
      ticketRef.current = null;
    }
  }, [open]);

  const selectFile = (selected: File) => {
    let description = "";
    if (!selected.name.toLowerCase().endsWith(".zip")) {
      description = "Please choose a .zip archive.";
    } else if (selected.size < 1 || selected.size > 50 * 1024 * 1024) {
      description = "ZIP archives must be between 1 byte and 50 MB.";
    } else if (
      retryJobId &&
      (selected.name !== retryFilename ||
        (retryDeclaredBytes !== undefined &&
          selected.size !== retryDeclaredBytes))
    ) {
      description = "Choose the same ZIP file used by this failed import.";
    }
    if (description) {
      toast({
        title: "Archive not accepted",
        description,
        variant: "destructive",
      });
      return;
    }
    ticketRef.current = null;
    setFile(selected);
    setUploadState("idle");
    setErrorMsg(null);
    setProgress(0);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) selectFile(selected);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) {
      selectFile(dropped);
    }
  };

  const startUpload = async () => {
    if (!file) return;

    setUploadState("creating_job");
    setErrorMsg(null);

    try {
      let ticket = ticketRef.current;
      if (!ticket) {
        if (retryJobId) {
          ticket = await retryImport.mutateAsync({
            appId,
            importJobId: retryJobId,
          });
        } else {
          ticket = await createImport.mutateAsync({
            appId,
            data: {
              filename: file.name,
              size: file.size,
              idempotencyKey: crypto.randomUUID(),
            },
          });
        }
        ticketRef.current = ticket;
      }

      setUploadState("uploading");
      setProgress(0);

      // 2. Upload via XHR for progress
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhrRef.current = xhr;

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const percent = Math.round((event.loaded / event.total) * 100);
            setProgress(percent);
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed with status ${xhr.status}`));
          }
        };

        xhr.onerror = () => reject(new Error("Network error during upload"));
        xhr.onabort = () => reject(new Error("Upload aborted"));

        xhr.open("PUT", ticket.uploadUrl);
        xhr.setRequestHeader("Content-Type", ticket.requiredContentType);
        xhr.send(file);
      });

      // 3. Complete Job
      setUploadState("completing");
      await completeImport.mutateAsync({
        appId,
        importJobId: ticket.job.id,
      });

      setUploadState("success");
      queryClient.invalidateQueries({
        queryKey: getGetVenomAppQueryKey(appId),
      });
      queryClient.invalidateQueries({
        queryKey: getListVenomAppsQueryKey(),
      });

      toast({
        title: "Upload complete",
        description: "The archive is now being validated and inspected.",
      });

      setTimeout(() => setOpen(false), 2000);
    } catch (err: unknown) {
      setUploadState("error");
      setErrorMsg(
        err instanceof Error
          ? err.message
          : "An unexpected error occurred during upload.",
      );
    }
  };

  const isWorking =
    uploadState === "creating_job" ||
    uploadState === "uploading" ||
    uploadState === "completing";

  return (
    <Dialog open={open} onOpenChange={!isWorking ? setOpen : undefined}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[460px] rounded-2xl border-border/60 surface p-0 overflow-hidden shadow-lift">
        <div className="p-6 sm:p-8 sheen">
          <DialogHeader className="mb-6">
            <DialogTitle className="text-xl font-semibold tracking-tight flex items-center gap-2">
              <UploadCloud className="h-5 w-5" />
              {retryJobId ? "Retry import" : "Source upload"}
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground mt-2">
              {retryJobId
                ? `Upload a new archive for ${retryFilename || "this job"}.`
                : "Upload a .zip archive of your project source."}
            </DialogDescription>
          </DialogHeader>

          {!file ? (
            <div
               role="button"
               tabIndex={0}
               aria-label="Choose a ZIP archive, or drop one here"
              className="border border-dashed border-border/60 bg-foreground/[0.02] hover:bg-foreground/[0.04] transition-colors p-10 flex flex-col items-center justify-center cursor-pointer group rounded-xl"
              onClick={() => fileInputRef.current?.click()}
               onKeyDown={(event) => {
                 if (event.key === "Enter" || event.key === " ") {
                   event.preventDefault();
                   fileInputRef.current?.click();
                 }
               }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
            >
              <div className="h-12 w-12 rounded-full bg-foreground/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <FileArchive className="h-6 w-6 text-foreground/70" />
              </div>
              <p className="text-sm font-medium mb-1">
                Select Archive
              </p>
              <p className="text-xs text-muted-foreground text-center">
                Drag & drop or click to browse (Max 50MB)
              </p>
              <input
                type="file"
                accept=".zip"
               aria-label="ZIP archive"
                className="hidden"
                ref={fileInputRef}
                onChange={handleFileChange}
                data-testid="input-file-archive"
              />
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex items-center justify-between border border-border/60 p-4 bg-foreground/[0.02] rounded-xl shadow-soft">
                <div className="flex items-center gap-3 overflow-hidden">
                  <FileArchive className="h-8 w-8 text-foreground/70 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate" title={file.name}>
                      {file.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {(file.size / 1024 / 1024).toFixed(2)} MB
                    </p>
                  </div>
                </div>
                {!isWorking && uploadState !== "success" && (
                  <button
                    className="p-2 hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors shrink-0 rounded-full"
                    onClick={() => {
                      setFile(null);
                      setUploadState("idle");
                    }}
                    title="Remove file"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>

              {isWorking && (
                <div
                  className="space-y-2"
                  aria-live="polite"
                  aria-label={`Upload status ${uploadState}, ${progress} percent`}
                >
                  <div className="flex justify-between text-xs text-foreground/70 font-medium">
                    <span>
                      {uploadState === "creating_job" && "Initializing job..."}
                      {uploadState === "uploading" && "Transmitting..."}
                      {uploadState === "completing" && "Finalizing..."}
                    </span>
                    <span>{uploadState === "uploading" ? `${progress}%` : ""}</span>
                  </div>
                  <Progress value={progress} className="h-1 rounded-full bg-border" />
                </div>
              )}

              {uploadState === "success" && (
                <div
                  role="status"
                  className="flex items-center gap-2 text-sm font-medium text-foreground bg-foreground/10 p-3 rounded-lg"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Upload successful. Validating...
                </div>
              )}

              {uploadState === "error" && (
                <div
                  role="alert"
                  className="flex flex-col gap-1 text-sm font-medium text-destructive bg-destructive/10 p-3 rounded-lg"
                >
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />
                    Upload failed
                  </div>
                  <p className="text-xs">{errorMsg}</p>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <Button
                  variant="outline"
                  onClick={() => setOpen(false)}
                  disabled={isWorking}
                  className="rounded-md font-medium border-border/60 hover:bg-accent hover:text-accent-foreground transition-colors shadow-soft"
                >
                  {uploadState === "success" ? "Close" : "Cancel"}
                </Button>
                {uploadState !== "success" && (
                  <Button
                    onClick={startUpload}
                    disabled={isWorking}
                    className="rounded-md font-medium bg-foreground text-background hover:bg-foreground/90 transition-transform hover:scale-[1.02] active:scale-[0.98] shadow-soft"
                    data-testid="button-upload-archive"
                  >
                    {isWorking ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Working
                      </>
                    ) : uploadState === "error" ? (
                      "Retry"
                    ) : (
                      "Upload"
                    )}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}