import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { finding } from '@/test/fixtures';
import { ChatPanel } from './review/chat-panel';
import { FindingCard } from './review/finding-card';

vi.mock('@/lib/api', () => ({ api: { chatHistory: vi.fn(), askChat: vi.fn() } }));

const payload = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';

describe('rendering untrusted model / PR content', () => {
  it('escapes HTML in finding titles, explanations and suggestions', () => {
    const { container } = render(<FindingCard finding={finding({ title: payload, explanation: payload, suggestion: payload, codeSnippet: payload })} canEdit={false} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getAllByText(/onerror=/).length).toBeGreaterThan(0);
  });

  it('does not render raw HTML from chat markdown, and renders unicode/RTL text', async () => {
    vi.mocked(api.chatHistory).mockResolvedValue([
      { id: '1', role: 'assistant', content: `${payload}\n\n[click](javascript:alert(1)) **مرحبا** 🔐`, sources: [], createdAt: '' },
    ]);
    const client = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={client}>
        <ChatPanel pullRequestId="pr" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('مرحبا')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    const link = container.querySelector('a');
    expect(link?.getAttribute('href') ?? '').not.toMatch(/^javascript:/);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
