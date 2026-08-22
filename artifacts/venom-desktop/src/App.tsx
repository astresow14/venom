import { type ReactNode, Suspense, lazy, useEffect, useRef } from "react";
import { ClerkProvider, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import {
  isWorkspaceAccessDeniedError,
  notifyWorkspaceAccessLost,
} from "@/lib/workspace-access";
import { MotionConfig } from "framer-motion";
import { ErrorBoundary } from "@/components/error-boundary";
import { PageFallback } from "@/components/route-fallback";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { prefetchOnIdle } from "@/lib/prefetch-routes";
import { IS_UI_TEST } from "@/lib/ui-test";
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
  Redirect,
} from "wouter";

/**
 * Top-level routes are split so a phone only downloads the screen it is
 * actually on. The signed-out landing page and the Clerk-hosted auth screens
 * never ship with the workspace, and the workspace shell never ships with the
 * landing page.
 */
const loadLanding = () => import("@/pages/landing");
const loadSignIn = () => import("@/pages/auth/sign-in");
const loadSignUp = () => import("@/pages/auth/sign-up");
const loadWorkspace = () => import("@/routes/workspace-routes");
// Public share surfaces load for anonymous visitors; they must stay outside
// the workspace bundle and never touch the auth gate.
const loadShareEmbed = () => import("@/pages/share/embed");
const loadShare = () => import("@/pages/share/[slug]");

const LandingPage = lazy(loadLanding);
const SignInPage = lazy(loadSignIn);
const SignUpPage = lazy(loadSignUp);
const WorkspaceRoutes = lazy(loadWorkspace);
const ShareEmbedPage = lazy(loadShareEmbed);
const SharePage = lazy(loadShare);
// The 404 page is split like every other route so its Card/lucide imports
// stay off the critical path (Card keeps the tailwind-merge cn()).
const NotFound = lazy(() => import("@/pages/not-found"));

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");
}

// Revocation of shared-workspace access surfaces as a 403 with a dedicated
// code on any workspace-scoped request. Every such error funnels through
// these hooks so cached workspace content is evicted centrally.
const handleRequestError = (error: unknown) => {
  if (isWorkspaceAccessDeniedError(error)) notifyWorkspaceAccessLost();
};

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleRequestError }),
  mutationCache: new MutationCache({ onError: handleRequestError }),
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      // Access denial is deterministic — retrying cannot help.
      retry: (failureCount, error) =>
        !isWorkspaceAccessDeniedError(error) && failureCount < 2,
    },
  },
});

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    // The page already shows the Venom mark; a bitmap logo inside the card
    // cannot follow light/dark, so it is omitted.
    logoPlacement: "none" as const,
    socialButtonsPlacement: "top" as const,
  },
  variables: {
    colorPrimary: "#0a0a0a",
    colorBackground: "#ffffff",
    colorInput: "#ffffff",
    colorInputForeground: "#0a0a0a",
    colorNeutral: "#525252",
    fontFamily: "'Outfit', sans-serif",
    borderRadius: "0.75rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox:
      "bg-card border border-border w-[440px] max-w-full overflow-hidden shadow-2xl rounded-2xl",
    card: "!shadow-none !border-0 !bg-transparent",
    headerTitle: "!text-foreground !font-medium !tracking-tight",
    headerSubtitle: "!text-muted-foreground",
    socialButtonsBlockButtonText: "!text-foreground !font-medium",
    formFieldLabel: "!text-foreground/80 !text-sm !font-medium",
    footerActionLink: "!text-foreground !font-semibold hover:!text-foreground/80",
    footerActionText: "!text-muted-foreground",
    dividerText: "!text-muted-foreground",
    formFieldSuccessText: "!text-foreground",
    alertText: "!text-foreground",
    socialButtonsBlockButton:
      "!border-border !bg-background hover:!bg-muted !rounded-xl",
    formButtonPrimary:
      "!bg-foreground !text-background hover:!bg-foreground/90 !font-bold !tracking-wide !rounded-xl",
    formFieldInput:
      "!border-border !bg-background !text-foreground !rounded-xl focus:!border-foreground focus:!ring-1 focus:!ring-foreground",
    footerAction: "!bg-transparent",
    dividerLine: "!bg-border",
    alert: "!border-border !bg-muted !rounded-xl",
    otpCodeFieldInput:
      "!border-border !bg-background !text-foreground !rounded-xl",
    formFieldRow: "!gap-3",
    main: "!gap-5",
  },
};

function stripBase(path: string) {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const client = useQueryClient();
  const previousUserId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    return addListener(({ user }) => {
      const nextUserId = user?.id ?? null;
      if (
        previousUserId.current !== undefined &&
        previousUserId.current !== nextUserId
      ) {
        client.clear();
      }
      previousUserId.current = nextUserId;
    });
  }, [addListener, client]);

  return null;
}

function HomeRedirect() {
  // From the landing page the only two ways forward are the auth screens and
  // the workspace, so warm both once the page itself has painted.
  useEffect(() => prefetchOnIdle([loadSignIn, loadSignUp, loadWorkspace]), []);

  return (
    <>
      <Show when="signed-in">
        <Redirect to="/workspace/chat" />
      </Show>
      <Show when="signed-out">
        <LandingPage />
      </Show>
    </>
  );
}

function ProtectedWorkspace({ children }: { children: ReactNode }) {
  if (IS_UI_TEST) return children;

  return (
    <>
      <Show when="signed-in">{children}</Show>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
    </>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Suspense fallback={<PageFallback />}>
        <Switch>
          <Route path="/" component={HomeRedirect} />
          <Route path="/sign-in/*?" component={SignInPage} />
          <Route path="/sign-up/*?" component={SignUpPage} />
          <Route path="/workspace/*?">
            <ProtectedWorkspace>
              <WorkspaceRoutes />
            </ProtectedWorkspace>
          </Route>
          {/* Public share link + embed — intentionally unauthenticated. */}
          <Route path="/s/:slug/embed" component={ShareEmbedPage} />
          <Route path="/s/:slug" component={SharePage} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Sign in",
            subtitle: "Continue to Venom",
          },
        },
        signUp: {
          start: {
            title: "Create an account",
            subtitle: "Continue to Venom",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <ThemeProvider defaultTheme="dark" storageKey="venom-ui-theme">
        {/* Honour the OS reduced-motion setting for script-driven animation. */}
        <MotionConfig reducedMotion="user">
          <QueryClientProvider client={queryClient}>
            <ClerkQueryClientCacheInvalidator />
            <TooltipProvider>
              <Router />
              <Toaster />
            </TooltipProvider>
          </QueryClientProvider>
        </MotionConfig>
      </ThemeProvider>
    </ClerkProvider>
  );
}

function AppWithRouter() {
  return (
    <WouterRouter base={basePath}>
      <App />
    </WouterRouter>
  );
}

export default AppWithRouter;
