import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { ChatPanel } from './chat-panel';

vi.mock('@/lib/api', () => ({ api: { chatHistory: vi.fn(), askChat: vi.fn() } }));
const mocked = vi.mocked(api);

const msg = (id: string, role: 'user' | 'assistant', content: string) => ({ id, role, content, sources: role === 'assistant' ? [{ type: 'finding', ref: 'f', label: 'src/db.ts:12' }] : [], createdAt: '' });

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ChatPanel pullRequestId="pr1" />
    </QueryClientProvider>,
  );
}

describe('ChatPanel', () => {
  beforeEach(() => vi.resetAllMocks());

  it('shows history, sends a question and renders the grounded answer', async () => {
    mocked.chatHistory.mockResolvedValue([msg('1', 'user', 'Hi'), msg('2', 'assistant', 'Hello **there**')]);
    mocked.askChat.mockResolvedValue({ question: msg('3', 'user', 'Any SQL injection?'), answer: msg('4', 'assistant', 'Yes: `src/db.ts:12` builds SQL by concatenation.') });
    renderPanel();
    expect(await screen.findByText('there')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Ask about this pull request'), 'Any SQL injection?{Enter}');
    await waitFor(() => expect(mocked.askChat).toHaveBeenCalledWith('pr1', 'Any SQL injection?'));
    expect(await screen.findByText(/builds SQL by concatenation/)).toBeInTheDocument();
    expect(screen.getAllByText(/Sources: src\/db\.ts:12/).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Ask about this pull request')).toHaveValue('');
  });

  it('offers suggested questions and shows errors', async () => {
    mocked.chatHistory.mockResolvedValue([]);
    mocked.askChat.mockRejectedValue(new Error('Rate limited'));
    renderPanel();
    expect(await screen.findByText(/No questions yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send question' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Are there any security risks?' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Rate limited');
  });
});
