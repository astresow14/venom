import { SignUp } from '@clerk/react';
import { Link } from 'wouter';
import { VenomWordmark } from '@/components/venom-wordmark';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

export default function SignUpPage() {
  return (
    <main className="flex min-h-[100dvh] flex-col bg-background text-foreground">
      <header className="px-5 py-4 sm:px-8">
        <Link
          href="/"
          data-testid="link-home"
          className="inline-flex items-center gap-2.5 rounded-md text-[15px] font-medium tracking-tight text-foreground transition-colors hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground"
        >
          <VenomWordmark className="h-7" />
        </Link>
      </header>
      <div className="flex flex-1 items-center justify-center px-4 pb-16">
        <SignUp
          routing="path"
          path={`${basePath}/sign-up`}
          signInUrl={`${basePath}/sign-in`}
          fallbackRedirectUrl={`${basePath}/workspace/chat`}
        />
      </div>
    </main>
  );
}
