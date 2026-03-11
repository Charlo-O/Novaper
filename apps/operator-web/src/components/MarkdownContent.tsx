import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

export function MarkdownContent({ content, className = '' }: MarkdownContentProps) {
  const components: Components = {
    h1: ({ children }) => (
      <h1 className="text-lg font-bold mt-4 mb-2 first:mt-0">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="text-base font-bold mt-3 mb-1.5 first:mt-0">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="text-sm font-bold mt-2 mb-1 first:mt-0">{children}</h3>
    ),
    p: ({ children }) => (
      <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>
    ),
    code: ({ className: codeClassName, children, ...props }) => {
      const isInline = !codeClassName;
      if (isInline) {
        return (
          <code
            className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-sm font-mono text-pink-600 dark:text-pink-400"
            {...props}
          >
            {children}
          </code>
        );
      }
      return (
        <code className={`${codeClassName ?? ''} text-sm`} {...props}>
          {children}
        </code>
      );
    },
    pre: ({ children }) => (
      <pre className="my-2 p-3 rounded-lg bg-slate-900 dark:bg-slate-950 text-slate-100 text-sm overflow-x-auto font-mono leading-relaxed">
        {children}
      </pre>
    ),
    ul: ({ children }) => (
      <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>
    ),
    li: ({ children }) => (
      <li className="leading-relaxed">{children}</li>
    ),
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 underline underline-offset-2"
      >
        {children}
      </a>
    ),
    blockquote: ({ children }) => (
      <blockquote className="border-l-3 border-slate-300 dark:border-slate-600 pl-3 my-2 text-slate-600 dark:text-slate-400 italic">
        {children}
      </blockquote>
    ),
    table: ({ children }) => (
      <div className="my-2 overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
        <table className="min-w-full text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => (
      <thead className="bg-slate-100 dark:bg-slate-800">{children}</thead>
    ),
    th: ({ children }) => (
      <th className="px-3 py-1.5 text-left font-semibold border-b border-slate-200 dark:border-slate-700">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="px-3 py-1.5 border-b border-slate-100 dark:border-slate-800">
        {children}
      </td>
    ),
    hr: () => <hr className="my-3 border-slate-200 dark:border-slate-700" />,
    strong: ({ children }) => (
      <strong className="font-semibold">{children}</strong>
    ),
    em: ({ children }) => <em className="italic">{children}</em>,
  };

  return (
    <div className={`markdown-content ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
