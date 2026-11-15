import { useMemo } from 'react';
import hljs from 'highlight.js/lib/common';
import { cn } from '@/lib/utils';

/** Map a file name to a highlight.js language id (null = not supported). */
export function langFromPath(file: string | null | undefined): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(file || '')?.[1]?.toLowerCase();
  switch (ext) {
    case 'html': case 'htm': case 'xml': case 'svg': case 'xhtml':
      return 'xml';
    case 'css': case 'scss': case 'less':
      return 'css';
    case 'js': case 'mjs': case 'cjs': case 'jsx':
      return 'javascript';
    case 'ts': case 'tsx': case 'mts': case 'cts':
      return 'typescript';
    case 'json': case 'map': case 'jsonc':
      return 'json';
    case 'md': case 'markdown':
      return 'markdown';
    case 'sh': case 'bash': case 'zsh': case 'fish':
      return 'bash';
    case 'yml': case 'yaml':
      return 'yaml';
    case 'py':
      return 'python';
    default:
      return null;
  }
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Read-only code block with highlight.js colours (same .hljs-* palette the
 * markdown renderer uses). The highlighted markup is generated from escaped
 * source, so design files cannot inject anything into the app.
 */
export function CodeView({ code, lang, className }: { code: string; lang?: string | null; className?: string }) {
  const html = useMemo(() => {
    const language = lang && hljs.getLanguage(lang) ? lang : null;
    try {
      return language
        ? hljs.highlight(code, { language, ignoreIllegals: true }).value
        : hljs.highlightAuto(code).value;
    } catch {
      return escapeHtml(code);
    }
  }, [code, lang]);

  return (
    <pre className={cn('m-0 overflow-auto whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-dim', className)}>
      <code className="hljs block bg-transparent p-0 font-mono text-[inherit]" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}
