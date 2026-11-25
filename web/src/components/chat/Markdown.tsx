import { memo, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy, Download } from 'lucide-react';
import { api } from '@/lib/api';
import { cn, copyText } from '@/lib/utils';

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return '';
}

function CodeBlock({ children }: ComponentProps<'pre'>) {
  const [copied, setCopied] = useState(false);
  const child = Array.isArray(children) ? children[0] : children;
  const cls: string = (child as { props?: { className?: string } })?.props?.className || '';
  const lang = /language-([\w-]+)/.exec(cls)?.[1] || 'text';
  return (
    <div className="not-prose my-3 overflow-hidden rounded-[10px] border border-line bg-sunken">
      <div className="flex items-center justify-between border-b border-line bg-panel py-1 pl-3 pr-1.5 font-mono text-[11.5px] text-faint">
        <span>{lang}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-dim hover:bg-hover hover:text-fg"
          onClick={async () => { if (await copyText(textOf(children).replace(/\n$/, ''))) { setCopied(true); setTimeout(() => setCopied(false), 1400); } }}
        >
          {copied ? <Check className="size-3 text-accent" /> : <Copy className="size-3" />}
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="m-0 overflow-x-auto px-3.5 py-3 font-mono text-[12.8px] leading-relaxed [tab-size:2]">{children}</pre>
    </div>
  );
}

function deliverPath(href: string) {
  return /^\/api\/deliver\/[a-z0-9_]+(?:\?view=1)?$/i.test(href) ? href : null;
}

function DeliverLink({ href, children }: { href: string; children: ReactNode }) {
  const [downloaded, setDownloaded] = useState(false);
  const label = textOf(children) || 'Download';
  const isView = /[?&]view=1$/.test(href);
  if (isView && /\.(png|jpe?g|gif|webp|svg|bmp|ico)(\?|$)/i.test(label)) {
    // An image deliverable: render it inline.
    return (
      <img
        src={href}
        alt={label}
        className="my-3 max-h-[420px] rounded-[10px] border border-line"
        loading="lazy"
      />
    );
  }
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        api.download(href, label).then(() => { setDownloaded(true); setTimeout(() => setDownloaded(false), 1600); });
      }}
      className="my-1 inline-flex items-center gap-2 rounded-lg border border-line bg-raised px-3 py-1.5 text-[13px] font-medium text-accent no-underline hover:bg-hover"
    >
      <Download className="size-4" />
      <span>{downloaded ? 'saved' : label.replace(/^Download\s+/i, '')}</span>
    </a>
  );
}

const components = {
  pre: CodeBlock,
  a: ({ href, children }: ComponentProps<'a'>) => {
    const d = href ? deliverPath(href) : null;
    if (d) return <DeliverLink href={d} children={children} />;
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => { if (window.shmakkDesktop && href) { e.preventDefault(); window.shmakkDesktop.openExternal(href); } }}
      >
        {children}
      </a>
    );
  },
  table: ({ children }: ComponentProps<'table'>) => <div className="my-3 overflow-x-auto"><table className="my-0">{children}</table></div>,
};

export const Markdown = memo(function Markdown({ text, streaming, className }: { text: string; streaming?: boolean; className?: string }) {
  return (
    <div
      className={cn(
        'prose max-w-none break-words text-[14.5px] leading-[1.65] text-fg',
        'prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-fg prose-h1:text-[1.35em] prose-h2:text-[1.2em] prose-h3:text-[1.07em]',
        'prose-p:my-2.5 prose-ul:my-2.5 prose-ol:my-2.5 prose-li:my-0.5 prose-strong:text-fg prose-a:text-accent prose-a:underline-offset-2',
        'prose-blockquote:border-line-strong prose-blockquote:font-normal prose-blockquote:not-italic prose-blockquote:text-dim prose-hr:border-line',
        'prose-code:rounded-[5px] prose-code:border prose-code:border-line prose-code:bg-raised prose-code:px-1 prose-code:py-px prose-code:font-mono prose-code:text-[0.88em] prose-code:font-normal prose-code:text-fg prose-code:before:content-none prose-code:after:content-none',
        'prose-th:border prose-th:border-line prose-th:bg-raised prose-th:px-3 prose-th:py-1.5 prose-th:text-fg prose-td:border prose-td:border-line prose-td:px-3 prose-td:py-1.5',
        '[&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[inherit]',
        streaming && 'streaming-caret',
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
