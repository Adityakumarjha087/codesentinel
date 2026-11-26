'use client';

import { FolderGit2, GitPullRequest, LayoutDashboard, LogOut, Menu, ShieldCheck, Users, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { cn, hasRole } from '@/lib/utils';
import { Spinner } from '../states';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { ThemeToggle } from './theme-toggle';

const NAV = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/repos', label: 'Repositories', icon: FolderGit2 },
  { href: '/reviews', label: 'Reviews', icon: GitPullRequest },
  { href: '/settings', label: 'Team', icon: Users, role: 'admin' as const },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { user, status, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (status === 'anonymous') router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [status, router, pathname]);
  useEffect(() => setOpen(false), [pathname]);

  if (status !== 'authenticated' || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="Checking your session…" />
      </div>
    );
  }

  const nav = NAV.filter((n) => !n.role || hasRole(user.role, n.role));
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <div className="min-h-screen md:grid md:grid-cols-[240px_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-card focus:p-2">
        Skip to content
      </a>
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 w-60 border-r bg-card p-4 transition-transform md:sticky md:top-0 md:h-screen md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-label="Primary"
      >
        <div className="mb-6 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="size-6 text-primary" aria-hidden />
            CodeSentinel
          </Link>
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="Close menu" onClick={() => setOpen(false)}>
            <X />
          </Button>
        </div>
        <nav className="space-y-1">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(href) ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                isActive(href) ? 'bg-secondary font-medium text-secondary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </Link>
          ))}
        </nav>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setOpen(false)} aria-hidden />}

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur">
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu" onClick={() => setOpen(true)}>
            <Menu />
          </Button>
          <div className="flex-1" />
          <ThemeToggle />
          <div className="flex items-center gap-2 text-sm">
            <span className="hidden font-medium sm:inline" data-testid="current-user">
              {user.name ?? user.login}
            </span>
            <Badge variant="secondary">{user.role}</Badge>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Sign out"
            onClick={async () => {
              await logout();
              router.replace('/login');
            }}
          >
            <LogOut />
          </Button>
        </header>
        <main id="main" className="mx-auto w-full max-w-7xl flex-1 p-4 md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
