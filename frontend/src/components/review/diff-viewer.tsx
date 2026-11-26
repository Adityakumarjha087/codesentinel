'use client';

import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useRef } from 'react';
import type { Finding, ReviewFile } from '@/lib/types';
import { CATEGORY_LABEL, SEVERITY_LABEL } from '@/lib/utils';
import { Spinner } from '../states';

type DiffEditorInstance = Parameters<DiffOnMount>[0];
type Monaco = Parameters<DiffOnMount>[1];

function commentNode(f: Finding): HTMLElement {
  const el = document.createElement('div');
  el.className = 'cs-inline-comment';
  el.setAttribute('data-testid', 'inline-comment');
  el.style.cssText =
    'margin:2px 12px 6px 0;padding:6px 10px;border-left:3px solid var(--primary);background:var(--muted);color:var(--foreground);border-radius:6px;font-size:12px;line-height:1.45;overflow:hidden;';
  const title = document.createElement('div');
  title.style.fontWeight = '600';
  title.textContent = `CodeSentinel · ${SEVERITY_LABEL[f.severity]} · ${CATEGORY_LABEL[f.category]}: ${f.title}`;
  const body = document.createElement('div');
  body.style.cssText = 'opacity:.85;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;';
  body.textContent = f.suggestion !== null ? `Suggestion: ${f.suggestion === '' ? '(delete line)' : f.suggestion}` : f.explanation;
  el.append(title, body);
  return el;
}

/**
 * Side-by-side Monaco diff of one changed file with CodeSentinel findings rendered inline
 * (glyph markers + view zones under the flagged lines of the modified side).
 */
export function DiffViewer({ file, findings, focusLine }: { file: ReviewFile; findings: Finding[]; focusLine?: number }) {
  const { resolvedTheme } = useTheme();
  const editorRef = useRef<DiffEditorInstance | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decorations = useRef<string[]>([]);
  const zones = useRef<string[]>([]);

  const apply = useCallback(() => {
    const editor = editorRef.current?.getModifiedEditor();
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    decorations.current = editor.deltaDecorations(
      decorations.current,
      findings.map((f) => ({
        range: new monaco.Range(f.line, 1, f.endLine ?? f.line, 1),
        options: {
          isWholeLine: true,
          className: 'cs-line-highlight',
          glyphMarginClassName: `cs-glyph-${f.severity}`,
          glyphMarginHoverMessage: { value: `**${f.title}**\n\n${f.explanation}` },
        },
      })),
    );
    editor.changeViewZones((accessor) => {
      zones.current.forEach((id) => accessor.removeZone(id));
      zones.current = findings.map((f) => accessor.addZone({ afterLineNumber: f.endLine ?? f.line, heightInPx: 50, domNode: commentNode(f) }));
    });
  }, [findings]);

  useEffect(() => {
    apply();
  }, [apply, file.id]);

  useEffect(() => {
    if (focusLine) editorRef.current?.getModifiedEditor().revealLineInCenter(focusLine);
  }, [focusLine]);

  return (
    <div className="h-[520px] overflow-hidden rounded-lg border" data-testid="diff-viewer">
      <DiffEditor
        key={file.id}
        original={file.baseContent ?? ''}
        modified={file.headContent ?? ''}
        language={file.language ?? 'plaintext'}
        theme={resolvedTheme === 'dark' ? 'vs-dark' : 'light'}
        loading={<Spinner label="Loading diff editor…" />}
        options={{
          readOnly: true,
          renderSideBySide: true,
          glyphMargin: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 13,
          automaticLayout: true,
          renderOverviewRuler: false,
        }}
        onMount={(editor, monaco) => {
          editorRef.current = editor;
          monacoRef.current = monaco;
          decorations.current = [];
          zones.current = [];
          apply();
          if (focusLine) editor.getModifiedEditor().revealLineInCenter(focusLine);
        }}
      />
    </div>
  );
}
