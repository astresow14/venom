import { SignUp } from '@clerk/react';
import { Link } from 'wouter';
import { VenomMark } from '@/components/venom-mark';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

export default function SignUpPage() {
  return (
    <main className="min-h-[100dvh] bg-black text-white flex flex-col items-center justify-center p-4">
      <Link href="/" className="absolute top-6 left-6 md:top-8 md:left-8 flex items-center gap-2.5 text-base font-semibold tracking-tight hover:text-neutral-400 transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white">
        <VenomMark className="w-5 h-5" />
        Venom
      </Link>
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
        fallbackRedirectUrl={`${basePath}/workspace/chat`}
      />
    </main>
  );
}
