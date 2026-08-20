import { SignIn } from '@clerk/react';
import { Link } from 'wouter';
import { Hexagon } from 'lucide-react';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

export default function SignInPage() {
  return (
    <main className="min-h-[100dvh] bg-black text-white flex flex-col items-center justify-center p-4">
      <Link href="/" className="absolute top-6 left-6 md:top-8 md:left-8 flex items-center gap-2 font-bold text-xl hover:text-neutral-400 transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white">
        <Hexagon className="w-6 h-6 fill-foreground" />
        VENOM
      </Link>
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
        fallbackRedirectUrl={`${basePath}/workspace/chat`}
      />
    </main>
  );
}
