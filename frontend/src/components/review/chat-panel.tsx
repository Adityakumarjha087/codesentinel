'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Send, User as UserIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import { api } from '@/lib/api';
import type { ChatMessage } from '@/lib/types';
import { ErrorState, LoadingState, Spinner } from '../states';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Textarea } from '../ui/input';

const SUGGESTIONS = ['What should I fix first?', 'Are there any security risks?', 'Summarize the performance issues'];

export function ChatPanel({ pullRequestId }: { pullRequestId: string }) {
  const qc = useQueryClient();
  const [message, setMessage] = useState('');
  const key = ['chat', pullRequestId];
  const history = useQuery({ queryKey: key, queryFn: () => api.chatHistory(pullRequestId) });
  const ask = useMutation({
    mutationFn: (text: string) => api.askChat(pullRequestId, text),
    onSuccess: ({ question, answer }) => {
      qc.setQueryData<ChatMessage[]>(key, (prev = []) => [...prev, question, answer]);
      setMessage('');
    },
  });

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const text = message.trim();
    if (text && !ask.isPending) ask.mutate(text);
  };

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle>Chat with this PR</CardTitle>
        <CardDescription>Ask follow-up questions grounded in the review, diff and repository index.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="max-h-[420px] min-h-40 flex-1 space-y-3 overflow-y-auto pr-1" aria-live="polite" data-testid="chat-log">
          {history.isLoading && <LoadingState rows={2} label="Loading conversation" />}
          {history.isError && <ErrorState error={history.error} onRetry={() => history.refetch()} />}
          {history.data?.length === 0 && <p className="text-sm text-muted-foreground">No questions yet. Try one of the suggestions below.</p>}
          {history.data?.map((m) => (
            <div key={m.id} className="flex gap-2" data-testid={`chat-${m.role}`}>
              <span className="mt-0.5 rounded-full bg-muted p-1.5" aria-hidden>
                {m.role === 'assistant' ? <Bot className="size-3.5" /> : <UserIcon className="size-3.5" />}
              </span>
              <div className="min-w-0 flex-1 text-sm">
                <p className="sr-only">{m.role === 'assistant' ? 'CodeSentinel said' : 'You asked'}</p>
                <div className="prose-sm space-y-2 break-words [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_ul]:list-disc [&_ul]:pl-4">
                  <ReactMarkdown>{m.content}</ReactMarkdown>
                </div>
                {m.sources.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">Sources: {m.sources.slice(0, 4).map((s) => s.label).join(', ')}</p>
                )}
              </div>
            </div>
          ))}
          {ask.isPending && <Spinner label="Thinking…" />}
        </div>
        {ask.isError && <p role="alert" className="text-sm text-red-600">{(ask.error as Error).message}</p>}
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <Button key={s} type="button" variant="outline" size="sm" onClick={() => ask.mutate(s)} disabled={ask.isPending}>
              {s}
            </Button>
          ))}
        </div>
        <form onSubmit={submit} className="flex items-end gap-2">
          <label htmlFor="chat-input" className="sr-only">
            Ask about this pull request
          </label>
          <Textarea
            id="chat-input"
            value={message}
            maxLength={2000}
            placeholder="Ask about this pull request…"
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <Button type="submit" size="icon" aria-label="Send question" disabled={!message.trim() || ask.isPending}>
            <Send />
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
