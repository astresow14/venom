import { type ReactNode, useEffect, useRef } from 'react';
import {
  ClerkProvider,
  Show,
  useAuth,
  useClerk,
} from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { VenomWorkspaceProvider } from '@/context/venom-workspace';
import NotFound from '@/pages/not-found';
import LandingPage from '@/pages/landing';
import SignInPage from '@/pages/auth/sign-in';
import SignUpPage from '@/pages/auth/sign-up';
import WorkspaceLayout from '@/components/layout/Shell';
import ChatPage from '@/pages/workspace/chat';
import FeedPage from '@/pages/workspace/feed';
import BrainPage from '@/pages/workspace/brain';
import TasksPage from '@/pages/workspace/tasks';
import { ThemeProvider } from '@/components/theme-provider';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
  Redirect,
} from 'wouter';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY');
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      retry: 2,
    },
  },
});

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
    socialButtonsPlacement: 'top' as const,
  },
  variables: {
    colorPrimary: '#ffffff',
    colorForeground: '#ffffff',
    colorMutedForeground: '#a3a3a3',
    colorDanger: '#ef4444',
    colorBackground: '#050505',
    colorInput: '#111111',
    colorInputForeground: '#ffffff',
    colorNeutral: '#404040',
    fontFamily: "'Outfit', sans-serif",
    borderRadius: '0px',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox:
      'bg-[#050505] border border-[#404040] w-[440px] max-w-full overflow-hidden shadow-2xl',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: '!text-white !font-black !uppercase !tracking-tight',
    headerSubtitle: '!text-neutral-400 !font-mono',
    socialButtonsBlockButtonText: '!text-white !font-semibold',
    formFieldLabel: '!text-neutral-200 !font-mono !uppercase !text-xs',
    footerActionLink: '!text-white !font-bold',
    footerActionText: '!text-neutral-400',
    dividerText: '!text-neutral-500 !font-mono',
    identityPreviewEditButton: '!text-white',
    formFieldSuccessText: '!text-white',
    alertText: '!text-white',
    logoBox: '!h-10',
    logoImage: '!h-10 !w-auto',
    socialButtonsBlockButton:
      '!border-neutral-700 !bg-neutral-950 hover:!bg-neutral-900 !rounded-none',
    formButtonPrimary:
      '!bg-white !text-black hover:!bg-neutral-200 !font-black !uppercase !tracking-widest !rounded-none',
    formFieldInput:
      '!border-neutral-700 !bg-neutral-950 !text-white !rounded-none focus:!border-white',
    footerAction: '!bg-transparent',
    dividerLine: '!bg-neutral-800',
    alert: '!border-neutral-700 !bg-neutral-900 !rounded-none',
    otpCodeFieldInput: '!border-neutral-700 !bg-neutral-950 !text-white !rounded-none',
    formFieldRow: '!gap-3',
    main: '!gap-5',
  },
};

function stripBase(path: string) {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || '/'
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
  return (
    <>
      <Show when="signed-in">{children}</Show>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
    </>
  );
}

function AccountScopedWorkspace({ children }: { children: ReactNode }) {
  const { userId } = useAuth();

  return (
    <VenomWorkspaceProvider key={userId ?? 'signed-out'}>
      {children}
    </VenomWorkspaceProvider>
  );
}

function WorkspaceRouter() {
  return (
    <WorkspaceLayout>
      <Switch>
        <Route path="/workspace">
          <Redirect to="/workspace/chat" />
        </Route>
        <Route path="/workspace/chat" component={ChatPage} />
        <Route path="/workspace/feed" component={FeedPage} />
        <Route path="/workspace/brain" component={BrainPage} />
        <Route path="/workspace/tasks" component={TasksPage} />
        <Route component={NotFound} />
      </Switch>
    </WorkspaceLayout>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={HomeRedirect} />
        <Route path="/sign-in/*?" component={SignInPage} />
        <Route path="/sign-up/*?" component={SignUpPage} />
        <Route path="/workspace/*?">
          <ProtectedWorkspace>
            <AccountScopedWorkspace>
              <WorkspaceRouter />
            </AccountScopedWorkspace>
          </ProtectedWorkspace>
        </Route>
        <Route component={NotFound} />
      </Switch>
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
            title: 'Return to Venom',
            subtitle: 'Sign in to continue your workspace',
          },
        },
        signUp: {
          start: {
            title: 'Create your Venom account',
            subtitle: 'Your workspace stays with you across devices',
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <ThemeProvider defaultTheme="system" storageKey="venom-ui-theme">
        <QueryClientProvider client={queryClient}>
          <ClerkQueryClientCacheInvalidator />
          <TooltipProvider>
            <Router />
            <Toaster />
          </TooltipProvider>
        </QueryClientProvider>
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
