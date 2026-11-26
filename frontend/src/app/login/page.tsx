'use client';

import { useQuery } from '@tanstack/react-query';
import { LogIn as Github, ShieldCheck } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { ThemeToggle } from '@/components/layout/theme-toggle';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Role } from '@/lib/types';

function LoginForm() {
  const { status, devLogin } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/';
  const config = useQuery({ queryKey: ['auth-config'], queryFn: () => api.authConfig() });
  const [login, setLogin] = useState('demo-admin');
  const [role, setRole] = useState<Role>('admin');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') router.replace(next.startsWith('/') ? next : '/');
  }, [status, router, next]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await devLogin(login, role);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="items-center text-center">
        <ShieldCheck className="size-10 text-primary" aria-hidden />
        <CardTitle className="text-xl">Sign in to CodeSentinel</CardTitle>
        <CardDescription>AI code review for every pull request.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <Button asChild={config.data?.githubOAuth} className="w-full" variant="outline" disabled={!config.data?.githubOAuth}>
          {config.data?.githubOAuth ? (
            <a href="/api/auth/github/login">
              <Github /> Continue with GitHub
            </a>
          ) : (
            <span>
              <Github /> GitHub OAuth not configured
            </span>
          )}
        </Button>
        {config.data?.devLogin !== false && (
          <form onSubmit={onSubmit} className="space-y-3 border-t pt-5" aria-label="Demo login">
            <p className="text-sm text-muted-foreground">Offline demo mode: sign in as a seeded user with a role.</p>
            <div className="space-y-1">
              <label htmlFor="login" className="text-sm font-medium">
                Username
              </label>
              <Input id="login" value={login} onChange={(e) => setLogin(e.target.value)} required pattern="[a-zA-Z0-9_-]{2,39}" />
            </div>
            <div className="space-y-1">
              <label htmlFor="role" className="text-sm font-medium">
                Role
              </label>
              <Select id="role" className="w-full" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="admin">Admin: manage budgets and team</option>
                <option value="maintainer">Maintainer: triage findings</option>
                <option value="viewer">Viewer: read only</option>
              </Select>
            </div>
            {error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Signing in…' : 'Sign in with demo account'}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <div className="relative flex min-h-screen items-center justify-center p-4">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
