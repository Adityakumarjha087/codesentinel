'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/layout/app-shell';
import { ErrorState, LoadingState } from '@/components/states';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Role } from '@/lib/types';
import { hasRole, timeAgo } from '@/lib/utils';

export default function SettingsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const isAdmin = hasRole(user?.role, 'admin');
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.users(), enabled: isAdmin });
  const update = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) => api.updateUserRole(id, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  if (!isAdmin) return <ErrorState error={new Error('Only admins can manage the team.')} />;
  return (
    <>
      <PageHeader title="Team" description="Role-based access: admins manage budgets and roles, maintainers triage findings, viewers have read-only access." />
      {users.isLoading && <LoadingState rows={3} />}
      {users.isError && <ErrorState error={users.error} onRetry={() => users.refetch()} />}
      {update.isError && (
        <p role="alert" className="mb-3 text-sm text-red-600">
          {(update.error as Error).message}
        </p>
      )}
      {users.data && (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Last login</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.data.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>
                    <div className="font-medium">{u.name ?? u.login}</div>
                    <div className="text-xs text-muted-foreground">@{u.login}</div>
                  </TableCell>
                  <TableCell>
                    <Select
                      aria-label={`Role for ${u.login}`}
                      value={u.role}
                      disabled={u.id === user?.id || update.isPending}
                      onChange={(e) => update.mutate({ id: u.id, role: e.target.value as Role })}
                    >
                      <option value="admin">admin</option>
                      <option value="maintainer">maintainer</option>
                      <option value="viewer">viewer</option>
                    </Select>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{timeAgo(u.lastLoginAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </>
  );
}
